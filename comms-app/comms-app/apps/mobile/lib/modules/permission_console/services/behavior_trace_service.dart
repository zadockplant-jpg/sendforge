import 'dart:async';
import 'dart:math';

import '../models/behavior_trace_result.dart';
import 'mock_permission_repository.dart';

class BehaviorTraceService {
  final MockPermissionRepository repository;
  final Random _random = Random();

  BehaviorTraceService(this.repository);

  Future<BehaviorTraceResult> runTrace(String entityId) async {
    final delay = 2 + _random.nextInt(4);
    await Future<void>.delayed(Duration(seconds: delay));

    final base = repository.loadLastTrace(entityId);
    return BehaviorTraceResult(
      entityId: entityId,
      statusLabel: base.statusLabel,
      confidenceLabel: base.confidenceLabel,
      summary: base.summary,
      observedSignals: base.observedSignals,
      partnerSignals: base.partnerSignals,
      suggestedActions: base.suggestedActions,
      completedAt: DateTime.now(),
    );
  }
}
