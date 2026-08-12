import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { currentClaimVersion } from '../../live/types';
import { useLiveMeetingRuntime } from '../../live/LiveMeetingRuntimeProvider';

export function MeetingAudioPlayer() {
  const { state } = useLiveMeetingRuntime();
  const audioRef = useRef<ComponentRef<'audio'>>(null);
  const [sourceUrl, setSourceUrl] = useState<string>();
  const artifact = state.artifact;
  const mixedAsset = artifact?.audioAssets.find(
    (asset) =>
      asset.sourceKind === 'mixed' &&
      (asset.status === 'finalized' || asset.status === 'interrupted')
  );
  const meetingId = artifact?.id;
  const mixedAssetId = mixedAsset?.id;
  const selectedStartMs = useMemo(() => {
    const claim = artifact?.claims.find((candidate) => candidate.id === state.selectedClaimId);
    return claim ? currentClaimVersion(claim)?.startMs : undefined;
  }, [artifact?.claims, state.selectedClaimId]);

  useEffect(() => {
    let active = true;
    setSourceUrl(undefined);
    if (!meetingId || !mixedAssetId) return () => undefined;
    void window.electron.live
      .getAudioPlaybackUrl(meetingId, mixedAssetId)
      .then((url) => {
        if (active) setSourceUrl(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [meetingId, mixedAssetId]);

  useEffect(() => {
    if (selectedStartMs === undefined || !audioRef.current) return;
    const seek = () => {
      if (!audioRef.current) return;
      audioRef.current.currentTime = Math.max(0, selectedStartMs / 1_000);
    };
    if (audioRef.current.readyState >= 1) seek();
    else audioRef.current.addEventListener('loadedmetadata', seek, { once: true });
  }, [selectedStartMs, sourceUrl]);

  if (!sourceUrl) return null;
  return (
    <audio
      ref={audioRef}
      src={sourceUrl}
      controls
      preload="metadata"
      className="h-8 w-52 max-w-[30vw]"
      aria-label="Meeting audio"
    />
  );
}
