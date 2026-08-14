import type { HypothesisStatus, ScanStatus, VulnClass } from '@corvid/tool-contracts';

// Human labels + truthful lifecycle grouping for every ScanStatus (`02` §5.1, `01` §12). "Live"
// controls the pulsing indicator — a scan that is truly paused (awaiting_approval) is NOT shown
// as live; the promise on screen is that "live" means traffic could be moving right now.

export const SCAN_STATUS_LABEL: Record<ScanStatus, string> = {
  authorizing: 'Authorizing',
  crawling: 'Crawling',
  hypothesizing: 'Generating hypotheses',
  awaiting_approval: 'Awaiting your approval',
  testing: 'Testing (live)',
  reporting: 'Compiling report',
  completed: 'Completed',
  rejected: 'Rejected at gate',
  cancelled: 'Cancelled',
  stopped: 'Stopped',
};

export const SCAN_STATUS_LIVE: Record<ScanStatus, boolean> = {
  authorizing: true,
  crawling: true,
  hypothesizing: true,
  awaiting_approval: false,
  testing: true,
  reporting: true,
  completed: false,
  rejected: false,
  cancelled: false,
  stopped: false,
};

export const SCAN_STATUS_TERMINAL: Record<ScanStatus, boolean> = {
  authorizing: false,
  crawling: false,
  hypothesizing: false,
  awaiting_approval: false,
  testing: false,
  reporting: false,
  completed: true,
  rejected: true,
  cancelled: true,
  stopped: true,
};

export const HYPOTHESIS_STATUS_LABEL: Record<HypothesisStatus, string> = {
  pending: 'Pending decision',
  approved: 'Approved — queued to test',
  rejected: 'Rejected',
  tested: 'Tested',
  confirmed: 'Confirmed',
  not_confirmed: 'Not confirmed',
};

export const VULN_CLASS_LABEL: Record<VulnClass, string> = {
  jwt: 'JWT',
  ssrf: 'SSRF',
  injection: 'Injection',
  idor: 'IDOR',
};
