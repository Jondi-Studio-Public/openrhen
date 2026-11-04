import type {
  Action,
  CapacityWindow,
  FixedCommitment,
  PlanningConfig,
  Project,
  ProjectForecast
} from "../model/types.js";
import { planSchedule } from "../scheduling/schedule.js";

export function forecastProject(args: {
  project: Project;
  actions: Action[];
  now: Date;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  config?: PlanningConfig;
  arrivalMarginMinutes?: number;
}): ProjectForecast {
  const deadline =
    args.project.internalDeadlineAt ??
    args.project.externalDeadlineAt ??
    new Date(Math.max(args.now.getTime(), ...args.capacityWindows.map((window) => window.endsAt.getTime())));
  return planSchedule({
    ...args,
    projects: [args.project],
    horizonEnd: deadline,
    ...(args.config ? { config: args.config } : {})
  }).forecasts[0]!;
}
