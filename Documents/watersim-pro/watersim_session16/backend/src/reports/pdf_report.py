#!/usr/bin/env python3
"""
WaterSim Pro — PDF Report Generator
Reads JSON from stdin, writes PDF to stdout.

Dependencies: reportlab, matplotlib
  pip install reportlab matplotlib
"""

import sys
import json
import io
import math
from datetime import datetime
from xml.sax.saxutils import escape as xml_escape

# ── ReportLab imports ────────────────────────────────────────────────────────
from reportlab.lib              import colors
from reportlab.lib.pagesizes    import A4
from reportlab.lib.styles       import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units        import cm, mm
from reportlab.lib.enums        import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus         import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether, Image as RLImage
)
from reportlab.platypus.flowables import Flowable

# ── Matplotlib for charts ────────────────────────────────────────────────────
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np

# ── Colour palette ───────────────────────────────────────────────────────────
BRAND_BLUE   = colors.HexColor('#1E40AF')   # primary
BRAND_CYAN   = colors.HexColor('#0891B2')   # accent
BRAND_GREEN  = colors.HexColor('#16A34A')   # pass
BRAND_RED    = colors.HexColor('#DC2626')   # fail / violation
BRAND_AMBER  = colors.HexColor('#D97706')   # warning
BRAND_GREY   = colors.HexColor('#6B7280')
LIGHT_BLUE   = colors.HexColor('#DBEAFE')
LIGHT_GREY   = colors.HexColor('#F3F4F6')
MID_GREY     = colors.HexColor('#E5E7EB')

W, H = A4   # 595.28 x 841.89 pt

# ── Styles ───────────────────────────────────────────────────────────────────
def make_styles():
    base = getSampleStyleSheet()
    s = {}
    def add(name, **kw):
        s[name] = ParagraphStyle(name, parent=base['Normal'], **kw)

    add('Title',       fontSize=22, textColor=BRAND_BLUE,  spaceAfter=4,
        fontName='Helvetica-Bold', alignment=TA_LEFT)
    add('Subtitle',    fontSize=12, textColor=BRAND_GREY,  spaceAfter=2,
        fontName='Helvetica')
    add('H1',          fontSize=14, textColor=BRAND_BLUE,  spaceBefore=14,
        spaceAfter=6,  fontName='Helvetica-Bold')
    add('H2',          fontSize=11, textColor=BRAND_CYAN,  spaceBefore=10,
        spaceAfter=4,  fontName='Helvetica-Bold')
    add('Body',        fontSize=9,  textColor=colors.black, spaceAfter=4,
        fontName='Helvetica', leading=13)
    add('Small',       fontSize=8,  textColor=BRAND_GREY,  fontName='Helvetica')
    add('Caption',     fontSize=8,  textColor=BRAND_GREY,  alignment=TA_CENTER,
        fontName='Helvetica-Oblique', spaceAfter=8)
    add('TH',          fontSize=8,  textColor=colors.white, fontName='Helvetica-Bold',
        alignment=TA_CENTER)
    add('TD',          fontSize=8,  textColor=colors.black, fontName='Helvetica',
        alignment=TA_CENTER)
    add('TDLeft',      fontSize=8,  textColor=colors.black, fontName='Helvetica',
        alignment=TA_LEFT)
    add('PassBadge',   fontSize=8,  textColor=BRAND_GREEN, fontName='Helvetica-Bold')
    add('FailBadge',   fontSize=8,  textColor=BRAND_RED,   fontName='Helvetica-Bold')
    add('WarnBadge',   fontSize=8,  textColor=BRAND_AMBER, fontName='Helvetica-Bold')
    add('TOCItem',     fontSize=9,  textColor=BRAND_BLUE,  fontName='Helvetica',
        leftIndent=12, spaceAfter=3)
    return s

# ── Header / Footer ──────────────────────────────────────────────────────────
def on_page(canvas, doc, org_name, report_title):
    canvas.saveState()

    # Header bar
    canvas.setFillColor(BRAND_BLUE)
    canvas.rect(0, H - 28*mm, W, 28*mm, fill=1, stroke=0)

    canvas.setFillColor(colors.white)
    canvas.setFont('Helvetica-Bold', 10)
    canvas.drawString(1.5*cm, H - 12*mm, 'WaterSim Pro')
    canvas.setFont('Helvetica', 9)
    canvas.drawString(1.5*cm, H - 19*mm, report_title[:80])

    # Org name + logo placeholder (right)
    canvas.setFont('Helvetica-Bold', 9)
    canvas.drawRightString(W - 1.5*cm, H - 12*mm, org_name or '')

    # Footer
    canvas.setFillColor(LIGHT_GREY)
    canvas.rect(0, 0, W, 18*mm, fill=1, stroke=0)
    canvas.setStrokeColor(MID_GREY)
    canvas.line(1.5*cm, 18*mm, W - 1.5*cm, 18*mm)

    canvas.setFillColor(BRAND_GREY)
    canvas.setFont('Helvetica', 7.5)
    canvas.drawString(1.5*cm, 8*mm,
        f'WaterSim Pro | Generated {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}')
    canvas.drawRightString(W - 1.5*cm, 8*mm, f'Page {doc.page}')

    canvas.restoreState()

# ── Chart generators ─────────────────────────────────────────────────────────
def effluent_quality_bar_chart(summary, limits, width_pt=420, height_pt=180):
    """Grouped bar chart: effluent vs permit limit for key parameters."""
    params  = ['BOD', 'TSS', 'TN', 'TP', 'NH4']
    labels  = ['BOD\n(mg/L)', 'TSS\n(mg/L)', 'TN\n(mg/L)', 'TP\n(mg/L)', 'NH4\n(mg/L)']
    eff     = summary.get('effluent', {})
    lim     = limits or {}

    vals  = [_safe(eff.get(p)) for p in params]
    lvals = [_safe(lim.get(p)) for p in params]

    x = np.arange(len(params))
    w = 0.35

    fig, ax = plt.subplots(figsize=(width_pt/72, height_pt/72), dpi=120)
    bars_e = ax.bar(x - w/2, vals,  w, label='Effluent',      color='#1E40AF', alpha=0.9)
    bars_l = ax.bar(x + w/2, lvals, w, label='Permit Limit',  color='#D97706', alpha=0.7)

    # Colour bars red where limit exceeded
    for b_e, b_l, v, lv in zip(bars_e, bars_l, vals, lvals):
        if v is not None and lv is not None and v > lv:
            b_e.set_color('#DC2626')

    ax.set_xticks(x)
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel('Concentration (mg/L)', fontsize=8)
    ax.set_title('Effluent Quality vs. Permit Limits', fontsize=9, fontweight='bold')
    ax.legend(fontsize=7.5)
    ax.tick_params(axis='y', labelsize=7.5)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    fig.tight_layout(pad=0.5)

    buf = io.BytesIO()
    fig.savefig(buf, format='PNG', dpi=120, bbox_inches='tight')
    plt.close(fig)
    buf.seek(0)
    return buf

def cost_pie_chart(cost_breakdown, width_pt=200, height_pt=200):
    """Pie chart of annual cost breakdown."""
    if not cost_breakdown:
        return None

    cats = {
        'Energy':      _safe(cost_breakdown.get('energy', {}).get('cost_USD_yr')),
        'Chemicals':   _safe(cost_breakdown.get('chemicals', {}).get('total_USD_yr')),
        'Sludge':      _safe(cost_breakdown.get('sludge', {}).get('cost_USD_yr')),
        'Labour':      _safe(cost_breakdown.get('labour', {}).get('cost_USD_yr')),
        'Maintenance': _safe(cost_breakdown.get('maintenance', {}).get('cost_USD_yr')),
    }
    cats = {k: v for k, v in cats.items() if v and v > 0}
    if not cats:
        return None

    palette = ['#1E40AF', '#0891B2', '#16A34A', '#D97706', '#7C3AED']
    fig, ax = plt.subplots(figsize=(width_pt/72, height_pt/72), dpi=120)
    wedges, texts, autotexts = ax.pie(
        list(cats.values()),
        labels=list(cats.keys()),
        autopct='%1.0f%%',
        colors=palette[:len(cats)],
        startangle=90,
        textprops={'fontsize': 7},
    )
    for at in autotexts:
        at.set_fontsize(6.5)
        at.set_color('white')
    ax.set_title('Annual Cost Split', fontsize=9, fontweight='bold')
    fig.tight_layout(pad=0.3)

    buf = io.BytesIO()
    fig.savefig(buf, format='PNG', dpi=120, bbox_inches='tight')
    plt.close(fig)
    buf.seek(0)
    return buf

def dynamic_time_series_chart(steps, param, width_pt=430, height_pt=150):
    """Line chart of a parameter over the 24h diurnal cycle."""
    hours = [s.get('hour', i) for i, s in enumerate(steps)]
    infl  = [_safe(s.get('summary', {}).get('influent', {}).get(param)) for s in steps]
    effl  = [_safe(s.get('summary', {}).get('effluent', {}).get(param)) for s in steps]

    # Filter Nones
    if all(v is None for v in infl + effl):
        return None

    fig, ax = plt.subplots(figsize=(width_pt/72, height_pt/72), dpi=120)
    if any(v is not None for v in infl):
        ax.plot(hours, infl, color='#0891B2', linewidth=1.5, label='Influent', marker='o', markersize=3)
    if any(v is not None for v in effl):
        ax.plot(hours, effl, color='#16A34A', linewidth=1.5, label='Effluent', marker='s', markersize=3)
    ax.set_xlabel('Hour of Day', fontsize=8)
    ax.set_ylabel(f'{param} (mg/L or m³/d)', fontsize=8)
    ax.set_title(f'{param} — 24h Diurnal Profile', fontsize=9, fontweight='bold')
    ax.legend(fontsize=7.5)
    ax.set_xticks(range(0, 25, 4))
    ax.tick_params(labelsize=7.5)
    ax.spines['top'].set_visible(False)
    ax.spines['right'].set_visible(False)
    fig.tight_layout(pad=0.5)

    buf = io.BytesIO()
    fig.savefig(buf, format='PNG', dpi=120, bbox_inches='tight')
    plt.close(fig)
    buf.seek(0)
    return buf

# ── Helpers ───────────────────────────────────────────────────────────────────
def _safe(v):
    try:
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None

def _fmt(v, decimals=2, unit=''):
    if v is None or v == '' or v == 'N/A':
        return '—'
    try:
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return '—'
        s = f'{f:,.{decimals}f}'
        return f'{s} {unit}'.strip() if unit else s
    except (TypeError, ValueError):
        return str(v)

def _compliance_badge(value, limit, styles):
    if value is None or limit is None:
        return Paragraph('—', styles['Small'])
    if value <= limit:
        return Paragraph('✓ PASS', styles['PassBadge'])
    else:
        pct = ((value - limit) / limit * 100) if limit else 0
        return Paragraph(f'✗ FAIL (+{pct:.0f}%)', styles['FailBadge'])

def _table_style(header_color=BRAND_BLUE):
    return TableStyle([
        ('BACKGROUND',  (0, 0), (-1, 0),  header_color),
        ('TEXTCOLOR',   (0, 0), (-1, 0),  colors.white),
        ('FONTNAME',    (0, 0), (-1, 0),  'Helvetica-Bold'),
        ('FONTSIZE',    (0, 0), (-1, 0),  8),
        ('ALIGN',       (0, 0), (-1, 0),  'CENTER'),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, LIGHT_GREY]),
        ('FONTSIZE',    (0, 1), (-1, -1), 8),
        ('FONTNAME',    (0, 1), (-1, -1), 'Helvetica'),
        ('GRID',        (0, 0), (-1, -1), 0.3, MID_GREY),
        ('TOPPADDING',  (0, 0), (-1, -1), 3),
        ('BOTTOMPADDING',(0,0), (-1, -1), 3),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING',(0, 0), (-1, -1), 5),
    ])

# ── Section builders ─────────────────────────────────────────────────────────

def build_cover(d, styles, story):
    """Cover page."""
    story.append(Spacer(1, 3*cm))
    story.append(Paragraph('Simulation Report', styles['Title']))
    story.append(Spacer(1, 4*mm))
    story.append(HRFlowable(width='100%', thickness=2, color=BRAND_BLUE))
    story.append(Spacer(1, 4*mm))

    meta = [
        ['Project',    d.get('project_name', '—')],
        ['Flowsheet',  d.get('flowsheet_name', '—')],
        ['Run ID',     d.get('run_id', '—')],
        ['Mode',       d.get('mode', 'steady_state').replace('_', ' ').title()],
        ['Run by',     d.get('created_by', '—')],
        ['Date',       d.get('completed_at', '—')[:19] if d.get('completed_at') else '—'],
        ['Organisation', d.get('org_name', '—')],
    ]
    t = Table([[Paragraph(r[0], styles['H2']), Paragraph(r[1], styles['Body'])] for r in meta],
              colWidths=[5*cm, 11*cm])
    t.setStyle(TableStyle([
        ('VALIGN',      (0, 0), (-1, -1), 'TOP'),
        ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.white, LIGHT_GREY]),
        ('GRID',        (0, 0), (-1, -1), 0.3, MID_GREY),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING',(0, 0), (-1, -1), 8),
        ('TOPPADDING',  (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING',(0,0), (-1,-1),  5),
    ]))
    story.append(t)
    story.append(Spacer(1, 1*cm))

    # Status badge
    compliant = d.get('results', {}).get('summary', {}).get('compliant')
    violations = d.get('results', {}).get('summary', {}).get('permit_violations', [])
    if compliant is True:
        badge_text = '✓  ALL PERMIT LIMITS SATISFIED'
        badge_color = BRAND_GREEN
    elif compliant is False:
        badge_text = f'✗  {len(violations)} PERMIT VIOLATION(S) DETECTED'
        badge_color = BRAND_RED
    else:
        badge_text = '—  PERMIT COMPLIANCE UNKNOWN'
        badge_color = BRAND_AMBER

    bt = Table([[Paragraph(badge_text, ParagraphStyle('B', fontName='Helvetica-Bold',
                 fontSize=10, textColor=colors.white))]],
               colWidths=[16*cm])
    bt.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (0,0), badge_color),
        ('ALIGN',      (0,0), (0,0), 'CENTER'),
        ('TOPPADDING', (0,0), (0,0), 10),
        ('BOTTOMPADDING', (0,0), (0,0), 10),
        ('ROUNDEDCORNERS', [4]),
    ]))
    story.append(bt)
    story.append(PageBreak())

def build_plain_section(d, styles, story):
    """'In plain words' — layman's summary (backend `plain` key).

    Rendered as the first content section, right after the cover. Degrades
    gracefully: absent/malformed `plain` (old cached JSON) adds nothing.
    """
    plain = d.get('plain')
    if not isinstance(plain, dict):
        return

    def esc(s):
        return xml_escape(str(s if s is not None else ''))

    sec = []
    try:
        sec.append(Paragraph('In plain words', styles['H1']))
        sec.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
        sec.append(Spacer(1, 3*mm))

        # ── Verdict banner ──────────────────────────────────────────────────
        verdict = plain.get('verdict') or {}
        status  = verdict.get('status')
        banner_color = (BRAND_GREEN if status == 'pass'
                        else BRAND_RED if status == 'fail'
                        else BRAND_AMBER)
        headline = verdict.get('headline') or 'No plain-language verdict available.'
        bt = Table([[Paragraph(esc(headline),
                    ParagraphStyle('PlainVerdict', fontName='Helvetica-Bold',
                                   fontSize=10.5, textColor=colors.white, leading=14))]],
                   colWidths=[16*cm])
        bt.setStyle(TableStyle([
            ('BACKGROUND',    (0, 0), (0, 0), banner_color),
            ('TOPPADDING',    (0, 0), (0, 0), 8),
            ('BOTTOMPADDING', (0, 0), (0, 0), 8),
            ('LEFTPADDING',   (0, 0), (0, 0), 10),
            ('RIGHTPADDING',  (0, 0), (0, 0), 10),
            ('ROUNDEDCORNERS', [4]),
        ]))
        sec.append(bt)
        if verdict.get('detail'):
            sec.append(Spacer(1, 2*mm))
            sec.append(Paragraph(esc(verdict['detail']), styles['Body']))
        sec.append(Spacer(1, 3*mm))

        # ── The water story ─────────────────────────────────────────────────
        for item in (plain.get('waterStory') or []):
            if not isinstance(item, dict):
                continue
            sec.append(Paragraph(
                f"<b>{esc(item.get('label', ''))}.</b> {esc(item.get('text', ''))}",
                styles['Body']))

        # ── Quality table ───────────────────────────────────────────────────
        q_rows = [r for r in (plain.get('qualityRows') or []) if isinstance(r, dict)]
        if q_rows:
            sec.append(Paragraph('How clean is the water?', styles['H2']))
            header = [Paragraph(h, styles['TH']) for h in
                      ['What we measure', 'Coming in', 'Going out', 'Removed', 'Verdict']]
            rows = [header]
            for r in q_rows:
                judgment = r.get('judgment')
                if judgment == 'good':
                    j_cell = Paragraph('✓ good', styles['PassBadge'])
                elif judgment == 'ok':
                    j_cell = Paragraph('~ OK', styles['WarnBadge'])
                elif judgment == 'poor':
                    j_cell = Paragraph('✗ poor', styles['FailBadge'])
                else:
                    j_cell = Paragraph('—', styles['Small'])
                rem = _safe(r.get('removalPct'))
                rows.append([
                    Paragraph(
                        f"{esc(r.get('friendly', r.get('param', '')))}"
                        f"<br/><font size='6.5' color='#6B7280'>{esc(r.get('meaning', ''))}</font>",
                        styles['TDLeft']),
                    Paragraph(_fmt(r.get('in'), 1, esc(r.get('unit', ''))), styles['TD']),
                    Paragraph(_fmt(r.get('out'), 1, esc(r.get('unit', ''))), styles['TD']),
                    Paragraph(f'{rem:.0f}%' if rem is not None else '—', styles['TD']),
                    j_cell,
                ])
            t = Table(rows, colWidths=[6.4*cm, 2.5*cm, 2.5*cm, 2.0*cm, 2.6*cm])
            t.setStyle(_table_style())
            sec.append(t)

        # ── Compliance in words ─────────────────────────────────────────────
        c_story = [c for c in (plain.get('complianceStory') or []) if isinstance(c, dict)]
        if c_story:
            sec.append(Paragraph('Is the water legal to release?', styles['H2']))
            for c in c_story:
                sev = c.get('severity')
                col = ('#16A34A' if sev == 'none'
                       else '#DC2626' if sev in ('high', 'medium')
                       else '#D97706')
                sec.append(Paragraph(
                    f"<font color='{col}'>•</font>  {esc(c.get('text', ''))}",
                    styles['Body']))

        # ── Treatment steps ─────────────────────────────────────────────────
        steps = [s for s in (plain.get('treatmentSteps') or []) if isinstance(s, dict)]
        if steps:
            sec.append(Paragraph('The journey, step by step', styles['H2']))
            for i, s in enumerate(steps, 1):
                line = f"{i}.  <b>{esc(s.get('label', 'Step'))}</b> — {esc(s.get('explanation', ''))}"
                if s.get('keyFact'):
                    line += f" <i><font color='#6B7280'>({esc(s['keyFact'])})</font></i>"
                sec.append(Paragraph(line, styles['Body']))

        # ── Cost in everyday terms ──────────────────────────────────────────
        cost_lines = (plain.get('costStory') or {}).get('lines') or []
        if cost_lines:
            sec.append(Paragraph('What it costs', styles['H2']))
            for line in cost_lines:
                sec.append(Paragraph(f'•  {esc(line)}', styles['Body']))

        # ── Glossary (two-column) ───────────────────────────────────────────
        glossary = [g for g in (plain.get('glossary') or []) if isinstance(g, dict)]
        if glossary:
            sec.append(Paragraph('Plain-words dictionary', styles['H2']))
            cells = [Paragraph(
                f"<b>{esc(g.get('term', ''))}</b> — "
                f"<font size='7' color='#374151'>{esc(g.get('definition', ''))}</font>",
                styles['TDLeft']) for g in glossary]
            if len(cells) % 2:
                cells.append(Paragraph('', styles['TDLeft']))
            g_rows = [[cells[i], cells[i + 1]] for i in range(0, len(cells), 2)]
            gt = Table(g_rows, colWidths=[8*cm, 8*cm])
            gt.setStyle(TableStyle([
                ('VALIGN',        (0, 0), (-1, -1), 'TOP'),
                ('ROWBACKGROUNDS', (0, 0), (-1, -1), [colors.white, LIGHT_GREY]),
                ('TOPPADDING',    (0, 0), (-1, -1), 3),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 3),
                ('LEFTPADDING',   (0, 0), (-1, -1), 5),
                ('RIGHTPADDING',  (0, 0), (-1, -1), 5),
            ]))
            sec.append(gt)

        sec.append(PageBreak())
    except Exception:
        return  # never let the plain layer break the engineering report

    story.extend(sec)

def build_toc(sections, styles, story):
    story.append(Paragraph('Table of Contents', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 4*mm))
    for i, sec in enumerate(sections, 1):
        story.append(Paragraph(f'{i}.  {sec}', styles['TOCItem']))
    story.append(PageBreak())

def build_executive_summary(d, styles, story):
    story.append(Paragraph('1. Executive Summary', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    results = d.get('results', {})
    summary = results.get('summary', {})
    cost    = results.get('costBreakdown', {})
    inf     = summary.get('influent', {})
    eff     = summary.get('effluent', {})

    mode = d.get('mode', 'steady_state')
    mode_label = 'Steady-State' if mode == 'steady_state' else '24-Hour Dynamic'

    # Key metrics table
    q_inf   = _safe(inf.get('Q'))
    q_eff   = _safe(eff.get('Q'))
    q_rem   = _fmt((q_inf - q_eff) / q_inf * 100 if q_inf and q_eff else None, 1, '%')
    bod_rem = _calc_removal(inf.get('BOD'), eff.get('BOD'))
    tss_rem = _calc_removal(inf.get('TSS'), eff.get('TSS'))
    tn_rem  = _calc_removal(inf.get('TN'),  eff.get('TN'))
    tp_rem  = _calc_removal(inf.get('TP'),  eff.get('TP'))

    kpi = [
        ['Simulation mode',     mode_label,  'Nodes solved', str(summary.get('solvedNodes', '—'))],
        ['Influent flow',        _fmt(inf.get('Q'), 0, 'm³/d'),
         'Effluent flow',        _fmt(eff.get('Q'), 0, 'm³/d')],
        ['BOD removal',         bod_rem,      'TSS removal',  tss_rem],
        ['TN removal',          tn_rem,       'TP removal',   tp_rem],
    ]
    if cost:
        total = _safe(cost.get('total_USD_yr'))
        cpp   = _safe(cost.get('cost_per_m3_treated_USD'))
        kpi.append(['Total annual OPEX', _fmt(total, 0, 'USD/yr'),
                    'Unit treatment cost', _fmt(cpp, 3, 'USD/m³')])

    rows = [[Paragraph(str(c), styles['TDLeft'] if j % 2 == 0 else styles['TD'])
             for j, c in enumerate(row)] for row in kpi]
    t = Table(rows, colWidths=[4.5*cm, 4.5*cm, 4.5*cm, 4.5*cm])
    t.setStyle(TableStyle([
        ('ROWBACKGROUNDS', (0, 0), (-1, -1), [LIGHT_BLUE, colors.white]),
        ('GRID', (0,0), (-1,-1), 0.3, MID_GREY),
        ('FONTNAME', (0,0), (-1,-1), 'Helvetica'),
        ('FONTSIZE', (0,0), (-1,-1), 8.5),
        ('TOPPADDING', (0,0), (-1,-1), 5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 5),
        ('LEFTPADDING', (0,0), (-1,-1), 6),
    ]))
    story.append(t)
    story.append(Spacer(1, 5*mm))

    # Violations summary
    violations = summary.get('permit_violations', [])
    warnings   = d.get('warnings', [])
    if violations:
        story.append(Paragraph('⚠  Permit Violations', styles['H2']))
        for v in violations:
            story.append(Paragraph(f'• {v}', styles['Body']))
    if warnings:
        story.append(Paragraph('Simulation Warnings', styles['H2']))
        for w in warnings[:8]:
            story.append(Paragraph(f'• {w}', styles['Body']))

def build_influent_effluent(d, styles, story):
    story.append(Paragraph('2. Influent & Effluent Quality', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    results = d.get('results', {})
    summary = results.get('summary', {})
    inf     = summary.get('influent', {})
    eff     = summary.get('effluent', {})
    limits  = results.get('permitLimitsUsed', {}) or {}

    PARAMS = [
        ('Q',    'Flow',                'm³/d', 0),
        ('BOD',  'BOD',                 'mg/L', 1),
        ('COD',  'COD',                 'mg/L', 1),
        ('TSS',  'Total Suspended Solids', 'mg/L', 1),
        ('TN',   'Total Nitrogen',      'mg/L', 2),
        ('NH4',  'Ammonia (NH4-N)',     'mg/L', 2),
        ('NO3',  'Nitrate (NO3-N)',     'mg/L', 2),
        ('TP',   'Total Phosphorus',    'mg/L', 2),
        ('DO',   'Dissolved Oxygen',    'mg/L', 2),
        ('pH',   'pH',                  '—',    2),
        ('temp', 'Temperature',         '°C',   1),
    ]

    header = [Paragraph(h, styles['TH']) for h in
              ['Parameter', 'Unit', 'Influent', 'Effluent', 'Removal %', 'Permit Limit', 'Status']]
    rows = [header]

    for key, label, unit, dec in PARAMS:
        i_val = _safe(inf.get(key))
        e_val = _safe(eff.get(key))
        lim   = _safe(limits.get(key))
        rem   = _calc_removal(i_val, e_val) if key not in ('Q', 'pH', 'temp', 'DO') else '—'

        rows.append([
            Paragraph(label, styles['TDLeft']),
            Paragraph(unit,  styles['TD']),
            Paragraph(_fmt(i_val, dec), styles['TD']),
            Paragraph(_fmt(e_val, dec), styles['TD']),
            Paragraph(rem,   styles['TD']),
            Paragraph(_fmt(lim, dec) if lim else '—', styles['TD']),
            _compliance_badge(e_val, lim, styles) if key not in ('Q','pH','temp','DO') and lim else Paragraph('—', styles['Small']),
        ])

    t = Table(rows, colWidths=[4.2*cm, 1.6*cm, 2.0*cm, 2.0*cm, 2.0*cm, 2.4*cm, 2.2*cm])
    t.setStyle(_table_style())
    story.append(t)
    story.append(Spacer(1, 5*mm))

    # Bar chart
    try:
        chart_buf = effluent_quality_bar_chart(summary, limits)
        img = RLImage(chart_buf, width=420, height=180)
        story.append(img)
        story.append(Paragraph('Figure 1 — Effluent quality vs. permit limits', styles['Caption']))
    except Exception as e:
        story.append(Paragraph(f'[Chart generation failed: {e}]', styles['Small']))

def build_unit_operations(d, styles, story):
    story.append(Paragraph('3. Unit Operation Performance', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    unit_results = d.get('results', {}).get('unitResults', {})
    if not unit_results:
        story.append(Paragraph('No unit operation results available.', styles['Body']))
        return

    for node_id, ur in unit_results.items():
        op_type = ur.get('paletteType') or ur.get('type') or 'Unknown'
        metrics = ur.get('metrics', {})

        story.append(Paragraph(f'{op_type.replace("_"," ").title()} — {node_id}', styles['H2']))
        if not metrics:
            story.append(Paragraph('No metrics recorded.', styles['Small']))
            continue

        # Format metrics as 2-column table
        items = list(metrics.items())
        rows  = [[Paragraph('Metric', styles['TH']), Paragraph('Value', styles['TH'])]]
        for k, v in items:
            rows.append([
                Paragraph(k.replace('_', ' ').title(), styles['TDLeft']),
                Paragraph(_fmt(v), styles['TD']),
            ])
        t = Table(rows, colWidths=[8*cm, 8*cm])
        t.setStyle(_table_style(BRAND_CYAN))
        story.append(KeepTogether([t, Spacer(1, 4*mm)]))

def build_cost_section(d, styles, story):
    story.append(Paragraph('4. Operating Cost Estimate', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    cost = d.get('results', {}).get('costBreakdown')
    if not cost:
        story.append(Paragraph('Cost breakdown not available (dynamic mode or no cost data).', styles['Body']))
        return

    cats = [
        ('Energy',      cost.get('energy', {}),
         [('Aeration', 'aeration_kWh_yr', 'kWh/yr'),
          ('Pumping',   'pumping_kWh_yr',  'kWh/yr'),
          ('Total kWh', 'total_kWh_yr',    'kWh/yr'),
          ('Energy cost', 'cost_USD_yr',   'USD/yr')]),
        ('Chemicals',   cost.get('chemicals', {}),
         [('Coagulant', 'coagulant_USD_yr', 'USD/yr'),
          ('Polymer',   'polymer_USD_yr',   'USD/yr'),
          ('Disinfectant', 'disinfectant_USD_yr', 'USD/yr'),
          ('Total',     'total_USD_yr',     'USD/yr')]),
        ('Sludge Disposal', cost.get('sludge', {}),
         [('Wet tonnes/yr', 'wet_tonnes_yr', 't/yr'),
          ('Dry tonnes/yr', 'dry_tonnes_yr', 't/yr'),
          ('Disposal cost', 'cost_USD_yr',   'USD/yr')]),
        ('Labour',      cost.get('labour', {}),
         [('Staff count',   'staff_count',   ''),
          ('Labour cost',   'cost_USD_yr',   'USD/yr')]),
        ('Maintenance', cost.get('maintenance', {}),
         [('CAPEX estimate', 'capex_estimate_USD', 'USD'),
          ('Maintenance cost', 'cost_USD_yr', 'USD/yr')]),
    ]

    for cat_name, cat_data, fields in cats:
        story.append(Paragraph(cat_name, styles['H2']))
        rows = [[Paragraph(h, styles['TH']) for h in ['Item', 'Value', 'Unit']]]
        for label, key, unit in fields:
            v = cat_data.get(key)
            rows.append([
                Paragraph(label,   styles['TDLeft']),
                Paragraph(_fmt(v, 0), styles['TD']),
                Paragraph(unit,    styles['TD']),
            ])
        t = Table(rows, colWidths=[6*cm, 6*cm, 4*cm])
        t.setStyle(_table_style(BRAND_CYAN))
        story.append(t)
        story.append(Spacer(1, 4*mm))

    # Total
    total = _safe(cost.get('total_USD_yr'))
    cpp   = _safe(cost.get('cost_per_m3_treated_USD'))
    total_data = [
        [Paragraph('TOTAL ANNUAL OPEX', ParagraphStyle('x', fontName='Helvetica-Bold', fontSize=10)),
         Paragraph(_fmt(total, 0, 'USD/yr'),
                   ParagraphStyle('x2', fontName='Helvetica-Bold', fontSize=10, alignment=TA_RIGHT))],
        [Paragraph('Unit treatment cost', styles['Body']),
         Paragraph(_fmt(cpp, 3, 'USD/m³'), ParagraphStyle('x3', fontName='Helvetica', fontSize=9, alignment=TA_RIGHT))],
    ]
    tt = Table(total_data, colWidths=[10*cm, 6*cm])
    tt.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), LIGHT_BLUE),
        ('LINEBELOW',  (0,0), (-1,0), 1, BRAND_BLUE),
        ('TOPPADDING', (0,0), (-1,-1), 6),
        ('BOTTOMPADDING', (0,0), (-1,-1), 6),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
    ]))
    story.append(tt)
    story.append(Spacer(1, 5*mm))

    # Pie chart
    try:
        pie_buf = cost_pie_chart(cost)
        if pie_buf:
            img = RLImage(pie_buf, width=200, height=200)
            story.append(img)
            story.append(Paragraph('Figure 2 — Annual cost breakdown', styles['Caption']))
    except Exception as e:
        story.append(Paragraph(f'[Chart generation failed: {e}]', styles['Small']))

def build_streams_section(d, styles, story):
    story.append(Paragraph('5. Process Stream Results', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    stream_results = d.get('results', {}).get('streamResults', {})
    if not stream_results:
        story.append(Paragraph('No stream results available.', styles['Body']))
        return

    KEYS = ['Q', 'BOD', 'TSS', 'TN', 'NH4', 'NO3', 'TP', 'COD']
    header = [Paragraph(h, styles['TH']) for h in ['Stream / Edge ID'] + KEYS]
    rows = [header]

    for edge_id, s in stream_results.items():
        row = [Paragraph(edge_id[:30], styles['TDLeft'])]
        for k in KEYS:
            v = _safe(s.get(k))
            row.append(Paragraph(_fmt(v, 1), styles['TD']))
        rows.append(row)

    col_widths = [5*cm] + [1.6*cm] * len(KEYS)
    t = Table(rows, colWidths=col_widths)
    t.setStyle(_table_style())
    story.append(t)

def build_dynamic_section(d, styles, story):
    story.append(Paragraph('3. Dynamic Simulation Results', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    results = d.get('results', {})
    steps   = results.get('steps', [])
    if not steps:
        story.append(Paragraph('No dynamic step data available.', styles['Body']))
        return

    story.append(Paragraph(
        f'Simulation ran {len(steps)} time steps over a 24-hour diurnal cycle '
        f'(profile: {results.get("profileUsed", "default")}).',
        styles['Body']
    ))
    story.append(Spacer(1, 4*mm))

    for param in ['Q', 'BOD', 'TN', 'NH4']:
        try:
            buf = dynamic_time_series_chart(steps, param)
            if buf:
                img = RLImage(buf, width=430, height=150)
                story.append(img)
                story.append(Spacer(1, 2*mm))
        except Exception:
            pass

def build_appendix(d, styles, story):
    story.append(PageBreak())
    story.append(Paragraph('Appendix — Simulation Configuration', styles['H1']))
    story.append(HRFlowable(width='100%', thickness=0.5, color=MID_GREY))
    story.append(Spacer(1, 3*mm))

    config = d.get('config', {})
    if config:
        story.append(Paragraph('Node Parameters', styles['H2']))
        node_params = config.get('nodeParams', {})
        if node_params:
            rows = [[Paragraph(h, styles['TH']) for h in ['Node ID', 'Parameter', 'Value']]]
            for nid, params in node_params.items():
                if isinstance(params, dict):
                    for pk, pv in params.items():
                        rows.append([
                            Paragraph(nid[:30], styles['TDLeft']),
                            Paragraph(str(pk),  styles['TDLeft']),
                            Paragraph(str(pv),  styles['TD']),
                        ])
            if len(rows) > 1:
                t = Table(rows, colWidths=[5*cm, 7*cm, 4*cm])
                t.setStyle(_table_style(BRAND_GREY))
                story.append(t)
        else:
            story.append(Paragraph('Default parameters used for all nodes.', styles['Body']))

    story.append(Spacer(1, 5*mm))
    story.append(Paragraph(
        'This report was generated automatically by WaterSim Pro. '
        'All results are based on the mathematical models implemented in the simulation engine. '
        'Results should be reviewed by a qualified engineer before use in design or regulatory submissions.',
        styles['Small']
    ))

# ── Utility ───────────────────────────────────────────────────────────────────
def _calc_removal(i_val, e_val):
    try:
        iv = float(i_val)
        ev = float(e_val)
        if iv == 0:
            return '—'
        rem = (iv - ev) / iv * 100
        return f'{rem:.1f}%'
    except (TypeError, ValueError):
        return '—'

# ── Main ─────────────────────────────────────────────────────────────────────
def build_report(data: dict) -> bytes:
    buf = io.BytesIO()
    styles = make_styles()

    org_name     = data.get('org_name', '')
    flowsheet    = data.get('flowsheet_name', 'Report')
    run_id_short = data.get('run_id', '')[:8]
    report_title = f'{flowsheet} — Run {run_id_short}'

    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        topMargin=32*mm,
        bottomMargin=22*mm,
        leftMargin=1.8*cm,
        rightMargin=1.8*cm,
        title=report_title,
        author='WaterSim Pro',
        subject='Simulation Report',
    )

    story = []
    mode  = data.get('mode', 'steady_state')
    is_dynamic = (mode == 'dynamic')

    # Cover + plain-language summary + TOC
    build_cover(data, styles, story)
    build_plain_section(data, styles, story)

    sections = ['Executive Summary',
                'Influent & Effluent Quality',
                'Dynamic Simulation Results' if is_dynamic else 'Unit Operation Performance',
                'Operating Cost Estimate',
                'Process Stream Results',
                'Appendix — Simulation Configuration']
    build_toc(sections, styles, story)

    build_executive_summary(data, styles, story)
    story.append(PageBreak())

    build_influent_effluent(data, styles, story)
    story.append(PageBreak())

    if is_dynamic:
        build_dynamic_section(data, styles, story)
    else:
        build_unit_operations(data, styles, story)
    story.append(PageBreak())

    build_cost_section(data, styles, story)
    story.append(PageBreak())

    build_streams_section(data, styles, story)

    build_appendix(data, styles, story)

    def _page(canvas, d):
        on_page(canvas, d, org_name, report_title)

    doc.build(story, onFirstPage=_page, onLaterPages=_page)
    return buf.getvalue()


if __name__ == '__main__':
    raw  = sys.stdin.buffer.read()
    data = json.loads(raw)
    pdf  = build_report(data)
    sys.stdout.buffer.write(pdf)
