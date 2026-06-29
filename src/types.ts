export interface Settings {
  affineUrl: string;
  defaultWorkspace: string;
}

export interface SpecialNodeInfo {
  label: string;
  kind: string; // 'DrawIO' | 'Mermaid' | 'PlantUML' | 'Chart'
}

export interface CaptureJob {
  id: string;       // 'node-0', 'node-1', …
  element: Element; // original DOM element to capture
  info: SpecialNodeInfo;
}

export interface ExtractResult {
  type: 'EXTRACT_RESULT';
  title: string;
  markdown: string;
  wordCount: number;
  specialNodes: SpecialNodeInfo[];
}

export interface ExtractError {
  type: 'EXTRACT_ERROR';
  message: string;
}
