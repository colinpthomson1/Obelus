import { Clipboard, ExternalLink, Flag, RefreshCw } from 'lucide-react';
import { Button } from '../ui/button';
import type { Assessment, ClaimVersion } from '../../live/types';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

interface ResearchPacketProps {
  version: ClaimVersion;
  assessment: Assessment;
  canEscalate?: boolean;
}

function citedText(text: string, citationKeys: string[]): string {
  return `${text} ${citationKeys.length > 0 ? `[${citationKeys.join(', ')}]` : '[Citation unavailable]'}`;
}

function packetText(version: ClaimVersion, assessment: Assessment): string {
  const sources = assessment.sources
    .map(
      (source) =>
        `${source.citationKey}. ${source.publisher}: ${source.title}${source.retrievalKind ? ` (${source.retrievalKind === 'page_extract' ? 'page extract' : 'search snippet'})` : ''} — ${source.url}`
    )
    .join('\n');
  return [
    `${assessment.verdict ?? 'Unverified'} · ${assessment.confidence ?? 'Low'} confidence`,
    assessment.conclusion ? citedText(assessment.conclusion, assessment.citations.conclusion) : '',
    `Original quote: “${version.exactQuote}”`,
    `Interpreted claim: ${version.normalizedClaim}`,
    assessment.support.length
      ? `Supports:\n${assessment.support
          .map((item, index) => `- ${citedText(item, assessment.citations.support[index] ?? [])}`)
          .join('\n')}`
      : '',
    assessment.contradiction.length
      ? `Contradicts or qualifies:\n${assessment.contradiction
          .map(
            (item, index) => `- ${citedText(item, assessment.citations.contradiction[index] ?? [])}`
          )
          .join('\n')}`
      : '',
    assessment.caveats.length
      ? `Context:\n${assessment.caveats
          .map((item, index) => `- ${citedText(item, assessment.citations.caveats[index] ?? [])}`)
          .join('\n')}`
      : '',
    assessment.limitations.length
      ? `Limitations:\n${assessment.limitations
          .map(
            (item, index) => `- ${citedText(item, assessment.citations.limitations[index] ?? [])}`
          )
          .join('\n')}`
      : '',
    assessment.error?.code === 'evidence_unavailable'
      ? `Evidence limitation: ${assessment.error.message}`
      : '',
    sources ? `Evidence inventory (bounded retrieved set):\n${sources}` : '',
    'AI-generated research. Review the evidence trail before relying on this finding.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function CitationReferences({
  keys,
  assessment,
  openSource,
}: {
  keys: string[];
  assessment: Assessment;
  openSource: (url: string) => Promise<void>;
}) {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) {
    return (
      <span className="ml-1 text-xs font-medium text-status-context">Citation unavailable</span>
    );
  }
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-baseline">
      {uniqueKeys.map((key) => {
        const source = assessment.sources.find((candidate) => candidate.citationKey === key);
        return (
          <button
            key={key}
            type="button"
            disabled={!source}
            onClick={() => source && void openSource(source.url)}
            className="font-mono text-[11px] font-semibold text-brand-blue hover:underline disabled:text-status-context disabled:no-underline"
            aria-label={source ? `Open source ${key}` : `Missing source ${key}`}
          >
            [{key}]
          </button>
        );
      })}
    </span>
  );
}

export function ResearchPacket({ version, assessment, canEscalate = false }: ResearchPacketProps) {
  const { openSource, rerunClaim, escalateClaim, reportClaimProblem } = useLiveMeetingRuntime();
  return (
    <div className="mt-5 space-y-5">
      <div>
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
          Original quote
        </p>
        <blockquote className="mt-2 border-l-2 border-brand-blue pl-3 text-sm leading-6 text-text-secondary">
          “{version.exactQuote}”
        </blockquote>
      </div>

      <div>
        <p className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
          Interpreted claim
        </p>
        <p className="mt-2 text-sm font-medium leading-6 text-text-primary">
          {version.normalizedClaim}
        </p>
      </div>

      {assessment.support.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-status-supported">What supports it</h4>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-text-secondary">
            {assessment.support.map((item, index) => (
              <li key={index}>
                {item}
                <CitationReferences
                  keys={assessment.citations.support[index] ?? []}
                  assessment={assessment}
                  openSource={openSource}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {assessment.contradiction.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-status-disputed">
            What contradicts or qualifies it
          </h4>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-text-secondary">
            {assessment.contradiction.map((item, index) => (
              <li key={index}>
                {item}
                <CitationReferences
                  keys={assessment.citations.contradiction[index] ?? []}
                  assessment={assessment}
                  openSource={openSource}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {(assessment.caveats.length > 0 || assessment.limitations.length > 0) && (
        <div>
          <h4 className="text-sm font-semibold text-status-context">Context and limitations</h4>
          <ul className="mt-2 space-y-2 text-sm leading-6 text-text-secondary">
            {assessment.caveats.map((item, index) => (
              <li key={`caveat:${index}`}>
                {item}
                <CitationReferences
                  keys={assessment.citations.caveats[index] ?? []}
                  assessment={assessment}
                  openSource={openSource}
                />
              </li>
            ))}
            {assessment.limitations.map((item, index) => (
              <li key={`limitation:${index}`}>
                {item}
                <CitationReferences
                  keys={assessment.citations.limitations[index] ?? []}
                  assessment={assessment}
                  openSource={openSource}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {assessment.error?.code === 'evidence_unavailable' && (
        <div>
          <h4 className="text-sm font-semibold text-status-context">Evidence limitation</h4>
          <p className="mt-2 text-sm leading-6 text-text-secondary">{assessment.error.message}</p>
        </div>
      )}

      {assessment.sources.length > 0 && (
        <div>
          <h4 className="mb-2 font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
            Evidence inventory
          </h4>
          <p className="mb-3 text-xs leading-5 text-text-tertiary">
            These are the public-web pages Obelus retrieved for this claim. The finding may cite
            only this bounded set; it is not a preloaded database or a claim that every page online
            was searched.
          </p>
          <div className="divide-y divide-border-primary border-y border-border-primary">
            {assessment.sources.map((source) => (
              <button
                key={source.id}
                type="button"
                onClick={() => void openSource(source.url)}
                className="group/source grid w-full grid-cols-[1fr_auto] gap-3 py-3 text-left"
              >
                <span className="min-w-0">
                  <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">
                    {source.citationKey} · {source.publisher}
                    {source.publicationDate ? ` · ${source.publicationDate}` : ''}
                    {source.retrievalKind
                      ? ` · ${source.retrievalKind === 'page_extract' ? 'Page extract' : 'Search snippet'}`
                      : ''}
                  </span>
                  <span className="mt-1 block text-sm font-medium leading-5 text-text-primary group-hover/source:text-brand-blue">
                    {source.title}
                  </span>
                  {source.excerpt && (
                    <span className="mt-1.5 block line-clamp-3 text-xs leading-5 text-text-secondary">
                      {source.excerpt}
                    </span>
                  )}
                  <span className="mt-1 block text-[11px] leading-4 text-text-tertiary">
                    {source.qualityRationale}
                  </span>
                </span>
                <span className="flex items-center gap-2 pt-0.5">
                  <span className="text-[11px] font-medium capitalize text-text-secondary">
                    {source.stance}
                  </span>
                  <ExternalLink className="size-3.5 text-text-tertiary" aria-hidden />
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-border-primary pt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={() => assessment.sources[0] && void openSource(assessment.sources[0].url)}
          disabled={!assessment.sources[0]}
        >
          <ExternalLink className="size-3.5" /> Open source
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void navigator.clipboard.writeText(packetText(version, assessment))}
        >
          <Clipboard className="size-3.5" /> Copy packet
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void rerunClaim(version.claimId)}>
          <RefreshCw className="size-3.5" /> Rerun
        </Button>
        {canEscalate && (
          <Button variant="ghost" size="sm" onClick={() => void escalateClaim(version.claimId)}>
            <RefreshCw className="size-3.5" /> Research further
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => reportClaimProblem(version.claimId)}>
          <Flag className="size-3.5" /> Report problem
        </Button>
      </div>
      <p className="font-mono text-[10px] leading-4 text-text-tertiary">
        Completed{' '}
        {assessment.completedAt ? new Date(assessment.completedAt).toLocaleString() : 'recently'} ·
        Assessment attempt {assessment.attempt}
      </p>
    </div>
  );
}
