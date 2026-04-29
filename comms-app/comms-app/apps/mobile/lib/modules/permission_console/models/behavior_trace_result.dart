class BehaviorTraceResult {
  final String entityId;
  final String statusLabel;
  final String confidenceLabel;
  final String summary;
  final List<String> observedSignals;
  final List<String> partnerSignals;
  final List<String> suggestedActions;
  final DateTime completedAt;

  const BehaviorTraceResult({
    required this.entityId,
    required this.statusLabel,
    required this.confidenceLabel,
    required this.summary,
    required this.observedSignals,
    required this.partnerSignals,
    required this.suggestedActions,
    required this.completedAt,
  });
}
