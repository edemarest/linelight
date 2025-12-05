import type { EtaSource } from "@linelight/core";
import { FiClock, FiZap } from "react-icons/fi";

export const EtaSourceIndicator = ({ source }: { source: EtaSource | undefined }) => {
  if (source === "prediction" || source === "blended") {
    return (
      <span className="inline-flex items-center gap-1 text-2xs" style={{ color: "var(--line-blue)" }}>
        <FiZap title="Live prediction" />
      </span>
    );
  }
  if (source === "schedule") {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-slate-400">
        <FiClock /> Sched
      </span>
    );
  }
  return <span className="text-2xs text-slate-500">Est.</span>;
};
