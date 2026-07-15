export interface WindowSize {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
}

const TARGET_WIDTH = 1_440;
const TARGET_HEIGHT = 920;
const PREFERRED_MIN_WIDTH = 980;
const PREFERRED_MIN_HEIGHT = 680;
const ABSOLUTE_MIN_WIDTH = 680;
const ABSOLUTE_MIN_HEIGHT = 560;
const WORK_AREA_MARGIN = 32;

export function calculateInitialWindowSize(workArea: {
  width: number;
  height: number;
}): WindowSize {
  const availableWidth = Math.max(
    ABSOLUTE_MIN_WIDTH,
    Math.floor(workArea.width) - WORK_AREA_MARGIN,
  );
  const availableHeight = Math.max(
    ABSOLUTE_MIN_HEIGHT,
    Math.floor(workArea.height) - WORK_AREA_MARGIN,
  );
  const width = Math.min(TARGET_WIDTH, availableWidth);
  const height = Math.min(TARGET_HEIGHT, availableHeight);
  return {
    width,
    height,
    minWidth: Math.min(PREFERRED_MIN_WIDTH, width),
    minHeight: Math.min(PREFERRED_MIN_HEIGHT, height),
  };
}
