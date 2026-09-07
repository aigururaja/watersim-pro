/**
 * RoleDashboard — the home screen for the role that logged in.
 *
 * The server (GET /dashboard) decides which sections a role gets and in what
 * order; this component draws them. The plant strip runs across the top when
 * present; every other section is a card in the grid, some two columns wide.
 */
import {
  PlantStrip, AlarmsCard, DrivesCard, MyTasksCard, ApprovalsCard, TwinCard, PlcCard, CountersCard, ProjectsCard, RunsCard,
  ReadingsCard, NotificationsCard, TeamCard, IntegrationsCard, AuditCard, SystemCard,
} from './cards';

export const ROLE_META = {
  viewer:   { title: 'Plant overview',     blurb: 'What the plant is doing right now. You can look; acknowledging and control need an operator.' },
  operator: { title: 'Operator console',   blurb: 'Alarms to acknowledge, drives to watch, the tasks on your desk, and the readings that matter.' },
  engineer: { title: "Engineer's desk",    blurb: 'Your tasks, the twin and its drift, PLC health, run hours and trips, projects and recent runs.' },
  manager:  { title: "Manager's overview", blurb: 'Tasks waiting for your approval, alarm load and time-to-acknowledge, the team, and whether notifications get through.' },
  admin:    { title: 'Administration',     blurb: 'Users and logins, API keys and webhooks, notification delivery, PLC connections, the twin, the audit trail and system health.' },
};

export const SECTION_COMPONENTS = {
  plant: PlantStrip, alarms: AlarmsCard, equipment: DrivesCard, myTasks: MyTasksCard, approvals: ApprovalsCard,
  twin: TwinCard, plc: PlcCard, counters: CountersCard, projects: ProjectsCard, runs: RunsCard, readings: ReadingsCard,
  notifications: NotificationsCard, team: TeamCard, integrations: IntegrationsCard, audit: AuditCard, system: SystemCard,
};

export default function RoleDashboard({ data }) {
  const sections = (data.sections || []).filter((s) => SECTION_COMPONENTS[s] && data[s]);
  const cards = sections.filter((s) => s !== 'plant');
  return (
    <div className="space-y-4" data-role-dashboard={data.role}>
      {sections.includes('plant') && <PlantStrip data={data.plant} />}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 [grid-auto-flow:dense]" role="list" aria-label="Dashboard sections">
        {cards.map((s) => {
          const C = SECTION_COMPONENTS[s];
          return (
            <div key={s} role="listitem" className={C.span === 2 ? 'md:col-span-2' : ''}>
              <C data={data[s]} role={data.role} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
