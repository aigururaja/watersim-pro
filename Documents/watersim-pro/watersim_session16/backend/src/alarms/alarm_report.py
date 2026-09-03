#!/usr/bin/env python3
"""
WaterSim Pro — Alarm Report Generator
Reads JSON from stdin, writes PDF to stdout.

Dependencies: reportlab ONLY (no matplotlib — the tiles are drawn as tables,
so this script runs on hosts that never installed the charting stack).

Payload (see src/routes/alarms_org.js GET /alarms/report/pdf):
  {
    org_name, generated_at, filters: {...},
    period:   { from, to },
    tiles:    { total, critical, warning, info, active, cleared, acknowledged },
    frequent: [ { rule, count, lastSeen } ],
    events:   [ { triggeredAt, severity, rule, flowsheet, project, message,
                  valueLimit, state, acknowledged } ],
    truncated, eventLimit
  }
"""

import sys
import json
import io
from datetime import datetime, timezone
from xml.sax.saxutils import escape as xml_escape

from reportlab.lib           import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles    import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units     import cm, mm
from reportlab.lib.enums     import TA_LEFT, TA_CENTER
from reportlab.platypus      import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
)

# ── Colour palette (shared with src/reports/pdf_report.py) ───────────────────
BRAND_BLUE  = colors.HexColor('#1E40AF')   # primary
BRAND_CYAN  = colors.HexColor('#0891B2')   # accent
BRAND_GREEN = colors.HexColor('#16A34A')   # cleared / ok
BRAND_RED   = colors.HexColor('#DC2626')   # critical
BRAND_AMBER = colors.HexColor('#D97706')   # warning
BRAND_GREY  = colors.HexColor('#6B7280')
LIGHT_BLUE  = colors.HexColor('#DBEAFE')
LIGHT_GREY  = colors.HexColor('#F3F4F6')
MID_GREY    = colors.HexColor('#E5E7EB')

SEVERITY_HEX   = {'critical': '#DC2626', 'warning': '#D97706', 'info': '#0891B2'}
STATE_HEX      = {'cleared': '#16A34A', 'active': '#DC2626'}
GREY_HEX       = '#6B7280'

W, H = A4   # 595.28 x 841.89 pt


# ── Styles ───────────────────────────────────────────────────────────────────
def make_styles():
    base = getSampleStyleSheet()
    s = {}

    def add(name, **kw):
        s[name] = ParagraphStyle(name, parent=base['Normal'], **kw)

    add('Title',    fontSize=22, textColor=BRAND_BLUE,   spaceAfter=4,
        fontName='Helvetica-Bold', alignment=TA_LEFT)
    add('Subtitle', fontSize=11, textColor=BRAND_GREY,   spaceAfter=2, fontName='Helvetica')
    add('H1',       fontSize=14, textColor=BRAND_BLUE,   spaceBefore=14, spaceAfter=6,
        fontName='Helvetica-Bold')
    add('Body',     fontSize=9,  textColor=colors.black, spaceAfter=4,
        fontName='Helvetica', leading=13)
    add('Small',    fontSize=8,  textColor=BRAND_GREY,   fontName='Helvetica')
    add('TH',       fontSize=8,  textColor=colors.white, fontName='Helvetica-Bold',
        alignment=TA_CENTER)
    add('TD',       fontSize=8,  textColor=colors.black, fontName='Helvetica',
        alignment=TA_CENTER)
    add('TDLeft',   fontSize=8,  textColor=colors.black, fontName='Helvetica',
        alignment=TA_LEFT, leading=10)
    add('TileNum',  fontSize=20, textColor=colors.white, fontName='Helvetica-Bold',
        alignment=TA_CENTER, leading=23)
    add('TileLbl',  fontSize=7.5, textColor=colors.white, fontName='Helvetica',
        alignment=TA_CENTER, leading=10)
    return s


def esc(v):
    return xml_escape(str(v if v is not None else ''))


def _ts(value, length=16):
    """ISO timestamp → 'YYYY-MM-DD HH:MM' (never raises on odd input)."""
    if not value:
        return '—'
    s = str(value).replace('T', ' ')
    return s[:length]


def _table_style(header_color=BRAND_BLUE):
    return TableStyle([
        ('BACKGROUND',     (0, 0), (-1, 0),  header_color),
        ('TEXTCOLOR',      (0, 0), (-1, 0),  colors.white),
        ('FONTNAME',       (0, 0), (-1, 0),  'Helvetica-Bold'),
        ('FONTSIZE',       (0, 0), (-1, 0),  8),
        ('ALIGN',          (0, 0), (-1, 0),  'CENTER'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, LIGHT_GREY]),
        ('FONTSIZE',       (0, 1), (-1, -1), 8),
        ('VALIGN',         (0, 0), (-1, -1), 'TOP'),
        ('GRID',           (0, 0), (-1, -1), 0.3, MID_GREY),
        ('TOPPADDING',     (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING',  (0, 0), (-1, -1), 3),
        ('LEFTPADDING',    (0, 0), (-1, -1), 5),
        ('RIGHTPADDING',   (0, 0), (-1, -1), 5),
    ])


# ── Header / Footer ──────────────────────────────────────────────────────────
def on_page(canvas, doc, org_name, report_title):
    canvas.saveState()

    canvas.setFillColor(BRAND_BLUE)
    canvas.rect(0, H - 28 * mm, W, 28 * mm, fill=1, stroke=0)

    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 10)
    canvas.drawString(1.5 * cm, H - 12 * mm, 'WaterSim Pro')
    canvas.setFont('Helvetica', 9)
    canvas.drawString(1.5 * cm, H - 19 * mm, report_title[:80])
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawRightString(W - 1.5 * cm, H - 12 * mm, (org_name or '')[:60])

    canvas.setFillColor(LIGHT_GREY)
    canvas.rect(0, 0, W, 18 * mm, fill=1, stroke=0)
    canvas.setStrokeColor(MID_GREY)
    canvas.line(1.5 * cm, 18 * mm, W - 1.5 * cm, 18 * mm)

    canvas.setFillColor(BRAND_GREY)
    canvas.setFont('Helvetica', 7.5)
    stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    canvas.drawString(1.5 * cm, 8 * mm, f'WaterSim Pro | Generated {stamp}')
    canvas.drawRightString(W - 1.5 * cm, 8 * mm, f'Page {doc.page}')

    canvas.restoreState()


# ── Sections ─────────────────────────────────────────────────────────────────
def build_header(d, styles, story):
    period = d.get('period') or {}
    story.append(Paragraph('Alarm Report', styles['Title']))
    story.append(Paragraph(esc(d.get('org_name') or '—'), styles['Subtitle']))
    story.append(Spacer(1, 3 * mm))
    story.append(HRFlowable(width='100%', thickness=2, color=BRAND_BLUE))
    story.append(Spacer(1, 3 * mm))

    frm = _ts(period.get('from'))
    to  = _ts(period.get('to'))
    covered = 'No alarm events in range' if frm == '—' and to == '—' else f'{frm}  →  {to}'
    story.append(Paragraph(f'<b>Period covered:</b> {esc(covered)}', styles['Body']))

    filters = d.get('filters') or {}
    active = [f'{k} = {v}' for k, v in filters.items() if v not in (None, '')]
    if active:
        story.append(Paragraph(f'<b>Filters:</b> {esc(", ".join(active))}', styles['Body']))
    story.append(Spacer(1, 4 * mm))


def _tile(value, label, color, styles):
    """One coloured count tile as a single-cell table."""
    t = Table([[Paragraph(str(value), styles['TileNum'])],
               [Paragraph(esc(label), styles['TileLbl'])]],
              colWidths=[2.45 * cm], rowHeights=[11 * mm, 6 * mm])
    t.setStyle(TableStyle([
        ('BACKGROUND',    (0, 0), (-1, -1), color),
        ('VALIGN',        (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING',    (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('ROUNDEDCORNERS', [4]),
    ]))
    return t


def build_tiles(d, styles, story):
    tiles = d.get('tiles') or {}
    story.append(Paragraph('Summary', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3 * mm))

    spec = [
        (tiles.get('critical', 0),     'Critical',     BRAND_RED),
        (tiles.get('warning', 0),      'Warning',      BRAND_AMBER),
        (tiles.get('info', 0),         'Info',         BRAND_CYAN),
        (tiles.get('active', 0),       'Active',       BRAND_BLUE),
        (tiles.get('cleared', 0),      'Cleared',      BRAND_GREEN),
        (tiles.get('acknowledged', 0), 'Acknowledged', BRAND_GREY),
    ]
    row = [_tile(v, label, color, styles) for v, label, color in spec]
    holder = Table([row], colWidths=[2.65 * cm] * len(row))
    holder.setStyle(TableStyle([
        ('VALIGN',       (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING',  (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 3),
        ('TOPPADDING',   (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
    ]))
    story.append(holder)
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph(
        f"{tiles.get('total', 0)} alarm event(s) matched this report's filters.",
        styles['Small']))
    story.append(Spacer(1, 2 * mm))


def build_frequent(d, styles, story):
    frequent = [f for f in (d.get('frequent') or []) if isinstance(f, dict)]
    story.append(Paragraph('Most frequent alarms', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3 * mm))

    if not frequent:
        story.append(Paragraph('No alarm events in this period.', styles['Body']))
        return

    rows = [[Paragraph(h, styles['TH']) for h in ['Rule', 'Count', 'Last seen']]]
    for f in frequent:
        rows.append([
            Paragraph(esc(f.get('rule') or '—'), styles['TDLeft']),
            Paragraph(str(f.get('count', 0)),    styles['TD']),
            Paragraph(_ts(f.get('lastSeen')),    styles['TD']),
        ])
    t = Table(rows, colWidths=[9.5 * cm, 2.5 * cm, 4 * cm], repeatRows=1)
    t.setStyle(_table_style(BRAND_CYAN))
    story.append(t)
    story.append(Spacer(1, 4 * mm))


def build_events(d, styles, story):
    events = [e for e in (d.get('events') or []) if isinstance(e, dict)]
    story.append(Paragraph('Alarm events', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3 * mm))

    if not events:
        story.append(Paragraph('No alarm events matched the selected filters.', styles['Body']))
        return

    header = ['Time', 'Severity', 'Rule', 'Flowsheet', 'Message', 'Value / limit', 'State']
    rows = [[Paragraph(h, styles['TH']) for h in header]]

    for e in events:
        sev = str(e.get('severity') or '')
        sev_hex = SEVERITY_HEX.get(sev, GREY_HEX)
        state = str(e.get('state') or '')
        state_hex = STATE_HEX.get(state, GREY_HEX)
        rows.append([
            Paragraph(_ts(e.get('triggeredAt')), styles['TD']),
            Paragraph(f"<font color='{sev_hex}'><b>{esc(sev.upper())}</b></font>", styles['TD']),
            Paragraph(esc(e.get('rule') or '—'),      styles['TDLeft']),
            Paragraph(esc(e.get('flowsheet') or '—'), styles['TDLeft']),
            # Long messages wrap inside their Paragraph — never clipped, never
            # pushed off the page edge.
            Paragraph(esc(e.get('message') or '—'),   styles['TDLeft']),
            Paragraph(esc(e.get('valueLimit') or '—'), styles['TD']),
            Paragraph(f"<font color='{state_hex}'>{esc(state)}</font>", styles['TD']),
        ])

    # Column widths total 17.4 cm — exactly the A4 printable width left by the
    # 1.8 cm margins, so the table never spills past the right edge.
    t = Table(rows,
              colWidths=[2.1 * cm, 1.5 * cm, 2.9 * cm, 2.5 * cm, 5.0 * cm, 2.1 * cm, 1.3 * cm],
              repeatRows=1)
    t.setStyle(_table_style())
    story.append(t)

    if d.get('truncated'):
        story.append(Spacer(1, 3 * mm))
        story.append(Paragraph(
            f"Only the {d.get('eventLimit', len(events))} most recent events are listed — "
            'narrow the filters or use the CSV export for the full history.',
            styles['Small']))


# ── Main ─────────────────────────────────────────────────────────────────────
def build_report(data: dict) -> bytes:
    buf = io.BytesIO()
    styles = make_styles()

    org_name = data.get('org_name', '')
    report_title = 'Alarm Report'

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=32 * mm,
        bottomMargin=22 * mm,
        leftMargin=1.8 * cm,
        rightMargin=1.8 * cm,
        title=report_title,
        author='WaterSim Pro',
        subject='Alarm Report',
    )

    story = []
    build_header(data, styles, story)
    build_tiles(data, styles, story)
    build_frequent(data, styles, story)
    build_events(data, styles, story)

    def _page(canvas, d):
        on_page(canvas, d, org_name, report_title)

    doc.build(story, onFirstPage=_page, onLaterPages=_page)
    return buf.getvalue()


if __name__ == '__main__':
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw)
    sys.stdout.buffer.write(build_report(payload))
