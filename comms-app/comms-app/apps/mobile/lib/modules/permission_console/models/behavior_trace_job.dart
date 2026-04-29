enum BehaviorTraceStatus { idle, queued, processing, complete, stale, failed }

class BehaviorTraceJob {
  final String id;
  final String entityId;
  final BehaviorTraceStatus status;
  final DateTime createdAt;
  final DateTime? completedAt;

  const BehaviorTraceJob({
    required this.id,
    required this.entityId,
    required this.status,
    required this.createdAt,
    this.completedAt,
  });
}
