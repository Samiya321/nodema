// Complete TypeScript API contract matching cloudflare/api-worker (schema 0028).

export type NodeStatus =
  | "UP"
  | "DEGRADED"
  | "DOWN"
  | "UNKNOWN"
  | "STALE"
  | "UNSUPPORTED"
  | "ENVIRONMENT_ERROR";

export type NodeGroup = "SELF_HOSTED" | "AIRPORT";
export type SourceKind = "AUTO" | "SELF_HOSTED" | "AIRPORT";
export type EffectiveSourceKind = "SELF_HOSTED" | "AIRPORT" | "SUBSTORE";
export type SourceType = "SUBSCRIPTION_URL" | "RAW_TEXT" | "UPLOADED_FILE" | "SINGLE_URI";
export type SyncStatus = "NEVER" | "SUCCESS" | "PARTIAL" | "FAILED";
export type QualityGrade = "S" | "A" | "B" | "C" | "D" | "PENDING";
export type QualityBucket = QualityGrade | "NONE" | "OFF";
export type Vantage = "CN" | "CN-CT" | "CN-CU" | "CN-CM" | "HK" | "SG" | "GB";
export type UdpState = "SUCCESS" | "FAILED" | "NOT_SUPPORTED" | "NOT_RUN";
export type IpType = "RESIDENTIAL" | "HOSTING" | "MOBILE";
export type AccessEvidence = "ENDPOINT" | "PREFIX" | "CF_SHARED" | "ICMP";
export type ClassificationBasis =
  | "MANUAL"
  | "AIRPORT_SOURCE"
  | "HISTORICAL_AIRPORT"
  | "SHARED_CREDENTIAL"
  | "UNCONFIRMED";

export interface SessionInfo {
  authenticated: boolean;
  expires_in: number;
}

export interface PipelineScan {
  id: string;
  scope: string;
  status: string;
  done?: number;
  node_count?: number;
}

export interface RequestedScan {
  scope: string;
  nodes?: number;
}

export interface NeonTransfer {
  used: number;
  limit: number;
  period_end?: string | null;
}

export interface PipelineState {
  sources_total?: number;
  last_synced_at?: string | null;
  pending_sources: number;
  failed_sources: number;
  broken_sources: number;
  active_scans: PipelineScan[];
  requested_scans?: RequestedScan[];
  testable?: { SELF_HOSTED?: number; AIRPORT?: number };
  neon_transfer?: NeonTransfer | null;
}

export interface DispatchResponse {
  dispatched?: boolean;
  status?: string;
  reason?: string;
  sources?: number;
}

// ---- Overview ----
export interface OverviewStatus {
  observed_at: string;
  daily_enabled: boolean;
  probe_enabled: boolean;
  last_daily?: {
    id: string;
    status: string;
    lease_active?: boolean;
    scan_date?: string;
  } | null;
  last_complete?: {
    id: string;
    finished_at: string;
    scan_date?: string;
  } | null;
  latest_scan?: {
    id: string;
    scan_date: string;
    kind: string;
    scope: string;
    status: string;
    done: number;
    node_count: number;
  } | null;
  daily_history: Array<{
    id: string;
    scan_date: string;
    status: string;
    node_count: number;
  }>;
  queued_scan_at?: string | null;
  probe?: {
    finished_at?: string | null;
    error_code?: string | null;
    measurements?: number;
  } | null;
  host?: {
    taken_at: string;
    disk_free: number;
    disk_total: number;
    mem_available: number;
    tls_expires_at: string;
  } | null;
  capacity_24h?: {
    samples: number;
    connections_peak: number;
    db_peak_bytes: number;
  } | null;
  last_daily_capacity?: {
    scan_date: string;
    samples: number;
    connections_peak: number;
    mem_min_bytes: number;
  } | null;
  sources: {
    total: number;
    roots: number;
    children: number;
    pending: number;
  };
  exports: {
    active: number;
    serving: number;
    pending: number;
    unavailable: number;
  };
}

export interface OverviewRecovery {
  backup_available?: boolean;
  drill_available?: boolean;
  backup?: { created_at: string; expires_at?: string } | null;
  drill?: { result: string; finished_at: string; run_id?: number | string } | null;
}

export interface OverviewAttention {
  broken: number;
  never_worked: number;
  groups: Array<{
    id: string;
    name: string;
    total: number;
    worked: number;
    example_id: string;
    errors: string[];
    next_attempt?: string | null;
  }>;
  airports: Array<{
    risk: "expired" | "exhausted" | "soon" | "low";
    total: number;
    name: string;
    traffic_total?: number | null;
    used?: number | null;
    expires_at?: string | null;
  }>;
}

export interface GroupSummary {
  total: number;
  eligible: number;
  statuses: Record<string, number>;
}

export interface OverviewCatalog {
  total: number;
  statuses: Record<string, number>;
  groups: Record<string, GroupSummary>;
  countries: Record<string, number>;
}

export interface ProbeRunItem {
  started_at: string;
  peak: boolean;
  measurements: number;
  tests: number;
  stored: number;
  failed: number;
  rate_limited: number;
  error_code?: string | null;
}

export interface ProbeStatus {
  vantage: Vantage;
  grades: Partial<Record<QualityGrade, number>>;
  graded_at?: string | null;
  coverage_total?: number | null;
  coverage_measured?: number | null;
  coverage_endpoint_verified?: number | null;
  coverage_excluded?: number | null;
  tests_today: number;
  tests_7d: number;
  prefixes_graded: number;
  prefixes_peak: number;
  traces: number;
  storage_bytes?: number;
  daily?: Array<{ date: string; tests: number }>;
  runs?: ProbeRunItem[];
}

// ---- Nodes ----
export interface NodeListItem {
  id: string;
  short_id: string;
  name: string;
  protocol: string;
  status: NodeStatus;
  enabled: boolean;
  node_group: NodeGroup;
  classification_basis?: ClassificationBasis | null;
  quality_grade?: QualityGrade | null;
  quality_score?: number | null;
  limiting_vantage?: Vantage | null;
  endpoint_verified?: boolean | null;
  access_evidence?: AccessEvidence | null;
  unreachable?: boolean | null;
  icmp_only?: boolean | null;
  peak_rtt_ms?: number | null;
  peak_loss?: number | null;
  udp?: UdpState | null;
  udp_ms?: number | null;
  avail_7d?: number | null;
  checked_7d?: number | null;
  entry_country?: string | null;
  exit_country?: string | null;
  exit_asn?: number | null;
  exit_ip?: string | null;
  asn_label?: string | null;
  org_label?: string | null;
  exit_ip_type?: IpType | null;
  exit_ip_proxy?: boolean | null;
  server_node_count?: number;
  identity_flags?: number;
  present_source_count?: number;
  last_checked_at?: string | null;
}

export interface NodeDashboardFacets {
  total: number;
  available: number;
  exportable: number;
  udp: number;
  home: number;
  buckets: Partial<Record<QualityBucket, number>>;
  countries: string[];
}

export interface RawNodesPage {
  total: number;
  vantage: Vantage;
  fields: string[];
  items: unknown[][];
  facets?: NodeDashboardFacets;
}

export interface NodesDashboardResult {
  total: number;
  vantage: Vantage;
  items: NodeListItem[];
  facets?: NodeDashboardFacets;
  page: number;
  at: number;
}

export interface SourceChainItem {
  id: string;
  name: string;
  parent_source_id?: string | null;
  effective_kind?: EffectiveSourceKind;
  deleted_at?: string | null;
}

export interface NodeClassification {
  node_group: NodeGroup;
  classification_basis: ClassificationBasis;
  classification_override?: NodeGroup | null;
  classification_note?: string | null;
  classification_updated_at?: string | null;
  eligible: boolean;
}

export interface ObservationDay {
  day: string;
  status: "UP" | "DOWN" | "UNTESTED";
  successful: number;
  failed: number;
}

export interface NodeDetail {
  id: string;
  short_id: string;
  name: string;
  protocol: string;
  transport?: string | null;
  security?: string | null;
  server_host: string;
  server_port: number;
  status: NodeStatus;
  enabled: boolean;
  eligible?: boolean;
  node_group: NodeGroup;
  classification_basis?: ClassificationBasis | null;
  classification?: NodeClassification | null;
  vantage?: Vantage;
  quality_grade?: QualityGrade | null;
  limiting_vantage?: Vantage | null;
  endpoint_verified?: boolean | null;
  access_evidence?: AccessEvidence | null;
  unreachable?: boolean | null;
  avail_7d?: number;
  checked_7d?: number;
  entry_country?: string | null;
  entry_asn?: number | null;
  exit_country?: string | null;
  exit_ip?: string | null;
  exit_asn?: number | null;
  exit_asn_org?: string | null;
  exit_org?: string | null;
  exit_isp?: string | null;
  exit_region?: string | null;
  exit_ip_city?: string | null;
  exit_ip_type?: IpType | null;
  exit_ip_proxy?: boolean | null;
  exit_observed_at?: string | null;
  server_node_count?: number;
  identity_flags?: number;
  identity?: {
    raw_entry_country?: string | null;
    ipapi_country?: string | null;
    exit_country_source?: string | null;
    geolite_exit_country?: string | null;
    geolite_exit_asn?: number | null;
    observed_exit_asn?: number | null;
    observed_exit_org?: string | null;
    ipapi_asn?: number | null;
    ipapi_as_org?: string | null;
    ipapi_queried_at?: string | null;
  } | null;
  udp_state?: UdpState | null;
  udp_ms?: number | null;
  udp_success_at?: string | null;
  udp_exit_ip?: string | null;
  http_duration_ms?: number | null;
  http_p95_ms?: number | null;
  success_rate?: number | null;
  first_seen_at?: string | null;
  age_days?: number | null;
  available_days?: number | null;
  checked_days?: number | null;
  lifetime_availability?: number | null;
  measurement_kind?: string | null;
  last_checked_at?: string | null;
  last_error_code?: string | null;
  next_full_check_at?: string | null;
  published_observation?: {
    echo_source?: string | null;
    entry_ips?: string[];
    precheck_metadata?: {
      direct_exit_match?: boolean | null;
      udp?: Array<{ ok?: boolean; target?: string; dns_response?: string }>;
    };
  } | null;
  observations?: {
    days?: ObservationDay[];
    exit?: {
      observed_days: number;
      ip_count: number;
      country_count: number;
      asn_count: number;
      last_change_at?: string | null;
    } | null;
  } | null;
  sources: Array<{
    chain: SourceChainItem[];
    is_present: boolean;
    deleted: boolean;
    enabled: boolean;
    first_seen_at?: string | null;
    last_seen_at?: string | null;
  }>;
  exports?: Array<{
    id: string;
    name: string;
    version: number;
    serving: boolean;
  }>;
  history: Array<{
    checked_at: string;
    status: NodeStatus;
    exit_country?: string | null;
    exit_asn?: number | null;
    echo_source?: string | null;
    http_duration_ms?: number | null;
    dns_status: string;
    tcp_status: string;
    proxy_status: string;
    error_code?: string | null;
  }>;
}

export interface NodeAccessGrade {
  grade: QualityGrade;
  access_evidence?: AccessEvidence | null;
  limiting_vantage?: Vantage | null;
  unreachable?: boolean;
  peak_rtt_ms?: number | null;
  idle_rtt_ms?: number | null;
  loss?: number | null;
  jitter_ms?: number | null;
  samples: number;
  probes: number;
  access_band?: string | null;
  stability_band?: string | null;
  reasons?: string[];
}

export interface NodeAccessData {
  target?: string | null;
  icmp_only?: boolean;
  cloudflare?: boolean;
  grades?: Partial<Record<Vantage, NodeAccessGrade>>;
  traces?: Partial<Record<Vantage, { measured_at: string; hop_asns: number[] }>>;
  measurements?: Array<{
    measured_at: string;
    purpose?: string;
    vantage: Vantage;
    peak: boolean;
    target: string;
    probe_city?: string | null;
    probe_asn?: number | null;
    received: number;
    sent: number;
    rtt_avg?: number | null;
    measurement_id?: string | null;
  }>;
}

export interface NodeShareLink {
  name?: string;
  uri: string | null;
  error_code?: string | null;
  omitted?: string[];
}

export interface NodeAliasRow {
  source_name: string;
  is_present: boolean;
  aliases: string[];
}

export interface NodeAnnotation {
  tags: string[];
}

// ---- Sources / Airports / Sub-Store ----
export interface ProviderItem {
  id: string;
  name: string;
  website?: string | null;
}

export interface SourceItem {
  id: string;
  name: string;
  type: SourceType;
  kind: SourceKind;
  detected_kind: string;
  effective_kind: EffectiveSourceKind;
  enabled: boolean;
  url_host?: string | null;
  user_agent?: string | null;
  origin_label?: string | null;
  profile_title?: string | null;
  parent_source_id?: string | null;
  parent_name?: string | null;
  provider_id?: string | null;
  provider_name?: string | null;
  last_sync_status: SyncStatus;
  last_error_code?: string | null;
  last_checked_at?: string | null;
  last_success_at?: string | null;
  sync_requested_at?: string | null;
  next_attempt?: string | null;
  up_count: number;
  stale_up_count?: number;
  node_count: number;
  deleted_at?: string | null;
  in_parent?: boolean | null;
}

export interface BulkSourceResult {
  created: number;
  duplicates: number;
  invalid: number;
  items: Array<{
    id?: string;
    line: number;
    status: "CREATED" | "DUPLICATE" | "INVALID";
    error_code?: string;
  }>;
}

export interface AirportSource extends SourceItem {
  traffic_upload?: number | null;
  traffic_download?: number | null;
  traffic_total?: number | null;
  expires_at?: string | null;
  userinfo_at?: string | null;
  usable: boolean;
}

export interface AirportsResponse {
  providers: ProviderItem[];
  sources: AirportSource[];
  provider_counts?: Array<{ provider_id: string | null; up_count: number }>;
}

export interface SubStoreItem {
  id: string;
  name: string;
  url_host?: string | null;
  last_sync_status: SyncStatus;
  last_checked_at?: string | null;
  last_success_at?: string | null;
  last_error_code?: string | null;
  children: number;
  healthy_children: number;
  failed_children: number;
  node_count: number;
  last_parse_summary?: {
    children?: { missing_from_index?: string[] };
  } | null;
}

export interface SubStoreDetail {
  children: Array<{
    id: string;
    name: string;
    origin_label?: string | null;
    type: SourceType;
    url_host?: string | null;
    kind: SourceKind;
    detected_kind: string;
    last_sync_status: SyncStatus;
    last_error_code?: string | null;
    last_success_at?: string | null;
    node_count: number;
  }>;
}

export interface SourceLineageResponse {
  chain: Array<SourceItem & { in_parent?: boolean | null }>;
  relation: "children" | "references" | "present" | "current" | "stale" | "history";
  child_count: number;
  reference_count: number;
  present_count: number;
  up_count: number;
  stale_up_count: number;
  node_count: number;
  references: Array<{
    chain: SourceChainItem[];
    label: string;
    is_present: boolean;
    last_seen_at?: string | null;
  }>;
  page: {
    total: number;
    items: Array<Record<string, unknown>>;
  };
}

// ---- Exports ----
export type ExportFormat = "mihomo" | "singbox" | "uri" | "json" | "csv";
export type ExportStatus =
  | "READY"
  | "UPDATING"
  | "BUILDING"
  | "PENDING"
  | "FAILED"
  | "REVOKED"
  | "EXPIRED";

export interface ExportFilterSpec {
  q?: string;
  source_id?: string;
  enabled?: boolean;
  node_group?: NodeGroup | "";
  provider_id?: string;
  exit_country?: string;
  protocol?: string;
  vantage?: Vantage;
  min_quality_grade?: QualityGrade | "";
  quality_buckets?: QualityBucket[];
  best_per_server?: boolean;
  udp?: boolean;
  exit_ip_type?: IpType | "";
  exit_ip_proxy?: boolean;
  endpoint_verified?: boolean;
  stable_exit?: boolean;
  unreachable?: boolean;
  cross_border?: boolean;
  sort?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface ExportProfile {
  id: string;
  name: string;
  format: ExportFormat;
  status: ExportStatus;
  filter_spec: ExportFilterSpec;
  serving: boolean;
  node_count: number;
  payload_bytes: number;
  current_version: number;
  built_at?: string | null;
  expires_at?: string | null;
  error_code?: string | null;
  request_revision?: number;
  token?: string;
  pipeline?: { dispatched?: boolean };
}

export interface ExportVersion {
  version_no: number;
  created_at: string;
  node_count: number;
  payload_bytes: number;
}

export interface ExportMembersResponse {
  version: number;
  built_at?: string | null;
  serving: boolean;
  changed?: boolean;
  total: number;
  items: Array<{
    id: string;
    short_id: string;
    name?: string | null;
    status: NodeStatus;
  }>;
}

// ---- Scans & Usage ----
export interface ScanRunItem {
  id: string;
  scan_date: string;
  kind: string;
  scope: string;
  status: string;
  node_count: number;
  started_at: string;
  finished_at?: string | null;
  archived_at?: string | null;
  items?: Record<string, number>;
  error_summary?: { incomplete_shards?: number[]; code?: string } | null;
  shards?: Array<{
    shard_no: number;
    status: string;
    planned_count: number;
    completed_count: number;
    failed_count: number;
    error_summary?: { code?: string } | null;
  }>;
}

export interface UsageDatabaseSample {
  taken_at: string;
  table_bytes: number;
  database_bytes: number;
  transfer_bytes?: number | null;
  transfer_limit_bytes?: number | null;
  transfer_period_end?: string | null;
}

export interface UsageResponse {
  database_provider?: "self_hosted" | "neon" | string;
  runner_minutes: number;
  database_growth_bytes: number;
  totals: {
    preflight_skips: number;
    cooldown_skips: number;
  };
  health: {
    attempts: number;
    mean_check_ms?: number | null;
    timeout_ratio?: number | null;
    dns_timeouts: number;
    tcp_timeouts: number;
    https_timeouts: number;
    udp_timeouts: number;
  };
  executions: {
    failure_ratio?: number | null;
  };
  database_samples: UsageDatabaseSample[];
  neon_transfer?: {
    transfer_bytes: number;
    transfer_limit_bytes: number;
    transfer_period_end?: string | null;
    taken_at: string;
  } | null;
  latest_backup?: {
    created_at: string;
    expires_at?: string | null;
    expired?: boolean;
  } | null;
  action_runs: Array<{
    workflow: string;
    conclusion: string;
    started_at: string;
    runner_ms: number;
    job_count: number;
    failed_jobs: number;
  }>;
  recent: Array<{
    kind: string;
    started_at: string;
    outcome: string;
    check_count: number;
    timeout_checks: number;
  }>;
  daily: Array<{
    day: string;
    check_count: number;
    echo_requests: number;
    echo_failures: number;
    source_requests: number;
    source_response_bytes: number;
    subscription_downloads: number;
    subscription_bytes: number;
  }>;
}

// ---- Settings ----
export interface AppSettings {
  daily_scan_enabled: boolean;
  daily_scan_scope: "SELF_HOSTED" | "AIRPORT" | "ALL";
}

export interface NamingRules {
  template: string;
}

export interface AsnLabelItem {
  asn: number;
  organization?: string | null;
  nodes: number;
  label: string;
  overridden: boolean;
}

export interface AsnLabelsResponse {
  observed: AsnLabelItem[];
}

export interface GradingBand {
  rtt_ms: number;
  loss_pct: number;
  jitter_ms?: number;
  peak_rise_pct?: number;
}

export interface GradingPolicyData {
  default_vantage: Vantage;
  min_checked_days: number;
  min_probes: number;
  stability_pct: { S: number; A: number; B: number };
  bands: {
    CN: { S: GradingBand; A: GradingBand; B: GradingBand };
    OVERSEAS: { S: GradingBand; A: GradingBand; B: GradingBand };
  };
  s_requires_clean_exit: boolean;
  probe_enabled: boolean;
  peak_start: string;
  peak_end: string;
  coverage: "ALL" | "EXPORTS";
}

export interface GradingPolicyResponse {
  version: number;
  updated_at?: string | null;
  policy: GradingPolicyData;
  defaults: GradingPolicyData;
}
