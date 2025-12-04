export type RedNodes = RedNode[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParsedFlow = any;

export interface RedNode {
  type: string;
  label?: string;
  id: string;
  info?: string;
  disabled?: boolean;
  workLogic?: string;
  solutionId?: string;
  solutionGroupId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env?: any[];
  z?: string;
  name?: string;
  active?: boolean;
  tosidebar?: boolean;
  console?: boolean;
  tostatus?: boolean;
  complete?: string;
  statusVal?: string;
  statusType?: string;
  x?: number;
  y?: number;
  wires?: string[][];
  props?: Prop[];
  repeat?: string;
  crontab?: string;
  once?: boolean;
  onceDelay?: number;
  topic?: string;
  payload?: string;
  payloadType?: string;
  method?: string;
  ret?: string;
  paytoqs?: string;
  url?: string;
  tls?: string;
  persist?: boolean;
  proxy?: string;
  insecureHTTPParser?: boolean;
  authType?: string;
  senderr?: boolean;
  headers?: Header[];
  func?: string;
  outputs?: number;
  noerr?: number;
  initialize?: string;
  finalize?: string;
  libs?: Lib[];
  targetType?: string;
  property?: string;
  propertyType?: string;
  rules?: Rule[];
  checkall?: string;
  __envConfig?: Record<string, unknown>;
  repair?: boolean;
  action?: string;
  pretty?: boolean;
  server?: string;
  client?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scope?: any[];
  uncaught?: boolean;
  path?: string;
  wholemsg?: string;
  from?: string;
  to?: string;
  reg?: boolean;
}

export interface Prop {
  p: string;
  vt?: string;
}

export interface Header {
  keyType: string;
  keyValue: string;
  valueType: string;
  valueValue: string;
}

export interface Lib {
  var: string;
  module: string;
}

export interface Rule {
  t: string;
  p?: string;
  pt?: string;
  to?: string;
  tot?: string;
  v?: string;
  vt?: string;
}
