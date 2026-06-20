import * as React from "react";
import { SubAgentIconKey } from "./types";

const SearchIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <circle cx="10.25" cy="10.25" r="5.75" stroke="currentColor" strokeWidth="1.8" />
    <path
      d="M14.5 14.5L19.25 19.25"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CodeIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path
      d="M8.25 8L4.75 12L8.25 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M15.75 8L19.25 12L15.75 16"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M13.25 5.75L10.75 18.25"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const RobotIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path d="M12 2.75V5.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9.5 3.5H14.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <rect x="5.5" y="6.5" width="13" height="11" rx="3.5" stroke="currentColor" strokeWidth="1.7" />
    <path d="M3.75 10.25H5.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M18.5 10.25H20.25" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9.5" cy="11.25" r="1.1" fill="currentColor" />
    <circle cx="14.5" cy="11.25" r="1.1" fill="currentColor" />
    <path d="M9 14.5H15" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8.25 17.5V19.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15.75 17.5V19.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SparkIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
    <path
      d="M12 4.5L13.65 8.35L17.5 10L13.65 11.65L12 15.5L10.35 11.65L6.5 10L10.35 8.35L12 4.5Z"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path
      d="M18.5 15.5L19.3 17.2L21 18L19.3 18.8L18.5 20.5L17.7 18.8L16 18L17.7 17.2L18.5 15.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path
      d="M6 15.5L6.55 16.7L7.75 17.25L6.55 17.8L6 19L5.45 17.8L4.25 17.25L5.45 16.7L6 15.5Z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

const ICON_MAP: Record<SubAgentIconKey, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  search: SearchIcon,
  code: CodeIcon,
  robot: RobotIcon,
  spark: SparkIcon,
};

export const SubAgentIcon = ({ icon, className }: { icon: SubAgentIconKey; className?: string }) => {
  const IconComponent = ICON_MAP[icon] || RobotIcon;
  return <IconComponent className={className} aria-hidden="true" />;
};
