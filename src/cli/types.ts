// ANSI Color codes for console output
export interface ANSIColors {
  reset: string;
  bold: string;
  dim: string;
  italic: string;
  underline: string;
  inverse: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  gray: string;
}

// Tool descriptions mapping
export interface ToolDescriptions {
  [key: string]: string;
}

