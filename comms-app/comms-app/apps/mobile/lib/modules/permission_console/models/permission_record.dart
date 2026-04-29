enum PermissionStatus { allowed, limited, askFirst, blocked }

class DataPermission {
  final String label;
  final PermissionStatus status;
  final String detail;

  const DataPermission({
    required this.label,
    required this.status,
    required this.detail,
  });
}

class InteractionPermission {
  final String label;
  final PermissionStatus status;
  final String detail;

  const InteractionPermission({
    required this.label,
    required this.status,
    required this.detail,
  });
}

class TimeRule {
  final String label;
  final String value;
  final String detail;

  const TimeRule({
    required this.label,
    required this.value,
    required this.detail,
  });
}

class SecurityCheckpoint {
  final String label;
  final bool passed;
  final String detail;

  const SecurityCheckpoint({
    required this.label,
    required this.passed,
    required this.detail,
  });
}

class PermissionRecord {
  final String entityId;
  final List<DataPermission> dataPermissions;
  final List<InteractionPermission> interactionPermissions;
  final List<TimeRule> timeRules;
  final List<SecurityCheckpoint> checkpoints;
  final List<String> history;

  const PermissionRecord({
    required this.entityId,
    required this.dataPermissions,
    required this.interactionPermissions,
    required this.timeRules,
    required this.checkpoints,
    required this.history,
  });
}
