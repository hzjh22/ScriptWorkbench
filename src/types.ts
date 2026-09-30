export type TaskKind = "python_task" | "command_task";
export type InterpreterType = "bundled" | "external";
export type ThemeMode = "light" | "dark";
export type ConcurrencyPolicy = "allow" | "reject" | "stop_existing";
export type OutputEncoding = "utf8" | "gbk";
export type RuntimeParameterType =
  | "text"
  | "number"
  | "boolean"
  | "choice"
  | "file"
  | "directory"
  | "secret";
export type ArgumentMode = "template" | "structured";
export type ScanConfidence = "high" | "medium" | "low";
export type ArgumentEmission =
  | "always"
  | "when_non_empty"
  | "when_true"
  | "when_false"
  | "repeat";
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "truthy"
  | "falsy"
  | "non_empty"
  | "empty";

export interface ArgumentCondition {
  field: string;
  operator: ConditionOperator;
  value: string | null;
}

export interface RuntimeParameterDefinition {
  name: string;
  label: string;
  description: string;
  type: RuntimeParameterType;
  required: boolean;
  defaultValue: string;
  options: string[];
  min: number | null;
  max: number | null;
  group?: string;
  advanced?: boolean;
  source?: string;
  confidence?: ScanConfidence;
  locked?: boolean;
  condition?: ArgumentCondition | null;
  derivedTemplate?: string | null;
  allowOverride?: boolean;
  enabled?: boolean;
}

export interface TaskArgumentRule {
  id: string;
  inputName: string;
  flag: string | null;
  emission: ArgumentEmission;
  valueTemplate: string;
  condition: ArgumentCondition | null;
  enabled: boolean;
}

export type ValidationKind =
  | "conditional_required"
  | "at_least_one"
  | "mutually_exclusive"
  | "range"
  | "enum"
  | "repeat";

export interface ValidationRule {
  kind: ValidationKind;
  fields: string[];
  condition: ArgumentCondition | null;
  min: number | null;
  max: number | null;
  options: string[];
  message: string;
}

export interface TaskReliabilityPolicy {
  timeoutSeconds: number;
  retryCount: number;
  retryDelaySeconds: number;
  concurrencyPolicy: ConcurrencyPolicy;
  outputEncoding: OutputEncoding;
}

export interface EnvVarEntry {
  key: string;
  value: string;
}

export type RuntimeValues = Record<string, string>;

export interface PythonTaskConfig {
  interpreterProfileId: string;
  scriptPath: string;
  argsTemplate: string;
  argumentMode?: ArgumentMode;
  argumentRules?: TaskArgumentRule[];
  validationRules?: ValidationRule[];
  scriptHash?: string | null;
  scanSnapshot?: ScriptScanPreview | null;
}

export interface ManagedScriptImport {
  scriptPath: string;
  sourcePath: string;
  copiedFiles: string[];
}

export interface ScanGroup {
  id: string;
  label: string;
  advanced: boolean;
}

export interface RelationshipCandidate {
  id: string;
  label: string;
  description: string;
  confidence: ScanConfidence;
  enabled: boolean;
  fromFields: string[];
  toFields: string[];
}

export interface ScriptScanPreview {
  taskName: string;
  description: string;
  framework: string;
  source: string;
  confidence: ScanConfidence;
  groups: ScanGroup[];
  parameters: RuntimeParameterDefinition[];
  argumentRules: TaskArgumentRule[];
  validationRules: ValidationRule[];
  relationshipCandidates: RelationshipCandidate[];
  diagnostics: string[];
  scriptHash: string;
  generatedArguments: string[];
  helpRecommended: boolean;
}

export interface ScriptScanDiff {
  added: string[];
  removed: string[];
  typeChanged: string[];
  defaultChanged: string[];
}

export interface ScriptScanStatus {
  status: "unchanged" | "changed" | "missing" | "not_scanned";
  currentHash: string | null;
  diff: ScriptScanDiff;
  preview: ScriptScanPreview | null;
}

export interface CommandTaskConfig {
  command: string;
}

export interface TaskRecord {
  id: string | null;
  kind: TaskKind;
  name: string;
  workingDirectory: string;
  envVars: EnvVarEntry[];
  tags: string[];
  notes: string;
  favorite: boolean;
  runtimeParameters: RuntimeParameterDefinition[];
  reliability: TaskReliabilityPolicy;
  createdAt: string;
  updatedAt: string;
  python: PythonTaskConfig | null;
  command: CommandTaskConfig | null;
}

export interface InterpreterProfile {
  id: string;
  name: string;
  type: InterpreterType;
  executablePath: string;
  isDefault: boolean;
}

export interface RunRecord {
  id: string;
  taskId: string | null;
  taskName: string;
  status: string;
  commandPreview: string;
  workingDirectory: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  stdoutLogPath: string;
  stderrLogPath: string;
  runtimeValues: RuntimeValues;
  attemptCount: number;
  terminationReason: string | null;
}

export interface RunOutput {
  stdout: string;
  stderr: string;
}

export interface ClearRunHistoryResult {
  deletedCount: number;
  deletedLogCount: number;
  failedLogCount: number;
}

export interface AppSettings {
  theme: ThemeMode;
  defaultInterpreterId: string | null;
  logRetentionDays: number;
  autoSaveEditor: boolean;
  confirmBeforeStop: boolean;
}

export interface CommandImportResult {
  task: TaskRecord;
  warnings: string[];
}

export interface RunStreamEvent {
  runId: string;
  chunk: string;
}

export interface RunStatusEvent {
  runId: string;
  status: string;
  exitCode: number | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface InterpreterHealth {
  ok: boolean;
  version: string;
  message: string;
}

export interface WorkspaceBackup {
  version: number;
  exportedAt: string;
  tasks: TaskRecord[];
  interpreters: InterpreterProfile[];
  settings: AppSettings;
}

export interface BundledPythonStatus {
  available: boolean;
  source: "managed" | "packaged" | "development" | "none";
  pythonPath: string | null;
  rootDir: string | null;
  version: string;
  message: string;
}

export interface MobileApiSettings {
  enabled: boolean;
  bindHost: string;
  port: number;
}

export interface MobileApiStatus extends MobileApiSettings {
  pairingCode: string;
  tokenConfigured: boolean;
  serverRunning: boolean;
  baseUrls: string[];
  message: string;
}

export interface SharedFolder {
  id: string;
  label: string;
  path: string;
}
