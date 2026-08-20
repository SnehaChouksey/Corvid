// The stdout markers the bundled runner wraps its BurstOutput in, so the gateway can extract the
// payload even if a dependency writes stray output. One source of truth for both sides.
export const BURST_OUTPUT_BEGIN = '__CORVID_BURST_BEGIN__';
export const BURST_OUTPUT_END = '__CORVID_BURST_END__';
