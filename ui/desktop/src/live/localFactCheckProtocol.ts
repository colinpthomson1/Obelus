import type {
  ClaimDetectionRequest,
  ClaimDetectionResponse,
  FactCheckStage,
  FactCheckSubmitRequest,
  GatewayJobResponse,
  LiveFactCheckMode,
} from './ipcTypes';

export const LOCAL_FACT_CHECK_MODEL = 'qwen3.5:9b-q4_K_M' as const;
export const LOCAL_FACT_CHECK_JOB_PREFIX = 'local-fact-' as const;
export const LOCAL_FACT_CHECK_EVIDENCE_SCOPE =
  'Local evidence is limited to English Wikipedia and Wikidata, which are secondary reference sources. It does not search the wider web or primary-source databases.';
export const CHATGPT_SUBSCRIPTION_FACT_CHECK_MODEL = 'gpt-5.6-sol' as const;
export const SUBSCRIPTION_WEB_EVIDENCE_SCOPE =
  'Evidence is discovered across the public web, ranked toward primary and authoritative sources, and synthesized by the signed-in ChatGPT account. Findings remain limited to the cited inventory.';

export interface LocalFactCheckSupport {
  available: boolean;
  mode: LiveFactCheckMode;
  model: string;
  evidenceScope: string;
  reason?: string;
}

export interface LocalFactCheckCitedStatement {
  text: string;
  citationIds: string[];
}

export interface LocalFactCheckAssessmentResult {
  stage: 'preliminary' | 'deep';
  originalQuote: string;
  normalizedClaim: string;
  verdict: 'Supported' | 'Mostly supported' | 'Mixed' | 'Unsupported' | 'Unverifiable';
  confidence: 'Low' | 'Medium' | 'High';
  conclusion: string;
  conclusionCitationIds: string[];
  statements: LocalFactCheckCitedStatement[];
  supports: LocalFactCheckCitedStatement[];
  contradictions: LocalFactCheckCitedStatement[];
  caveats: LocalFactCheckCitedStatement[];
  limitations: LocalFactCheckCitedStatement[];
  sources: Array<{
    citationId: string;
    stance: 'supports' | 'contradicts' | 'context';
    qualityScore: number;
    qualityRationale: string;
  }>;
  inventory: Array<{
    citationId: string;
    url: string;
    canonicalUrl: string;
    publisher: string;
    title: string;
    publicationDate: string | null;
    accessedAt: string;
    excerpt: string;
  }>;
  completedAt: string;
  aiGenerated: true;
  provenance: {
    provider: 'ollama' | 'chatgpt_codex';
    model: string;
    local: boolean;
    evidenceScope: string;
  };
}

export interface LocalFactCheckClient {
  readonly factCheckMode: Extract<LiveFactCheckMode, 'subscription_web' | 'local_wikimedia'>;
  checkSupport(): Promise<LocalFactCheckSupport>;
  detectClaims(
    request: ClaimDetectionRequest,
    foreground?: boolean
  ): Promise<ClaimDetectionResponse>;
  submitFactCheck(
    stage: FactCheckStage,
    request: FactCheckSubmitRequest
  ): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>>;
  pollFactCheck(
    meetingId: string,
    jobId: string
  ): Promise<GatewayJobResponse<LocalFactCheckAssessmentResult>>;
  releaseMeeting(meetingId: string): Promise<void>;
}

export function isLocalFactCheckJobId(jobId: string): boolean {
  return /^local-fact-[a-f0-9]{40}$/.test(jobId);
}
