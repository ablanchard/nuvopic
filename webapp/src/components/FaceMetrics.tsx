interface FaceMetricsProps {
  confidence: number | null;
  area: number;
}

export function FaceMetrics({ confidence, area }: FaceMetricsProps) {
  const confidenceLabel = confidence === null ? 'N/A' : confidence.toFixed(2);
  const areaLabel = area.toLocaleString();

  return (
    <div
      class="face-metrics"
      aria-label={`Confidence ${confidenceLabel}, area ${areaLabel} square pixels`}
    >
      <span title="Detection confidence">C {confidenceLabel}</span>
      <span title="Bounding-box area">{areaLabel} px²</span>
    </div>
  );
}
