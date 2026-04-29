abstract class PermissionArm {
  String get id;
  String get label;
  String get description;
}

class MessagingPermissionArm extends PermissionArm {
  @override
  String get id => 'messaging';
  @override
  String get label => 'Messaging Arm';
  @override
  String get description => 'Controls SMS, email, alerts, promotions, and reply permissions.';
}

class DataSharingPermissionArm extends PermissionArm {
  @override
  String get id => 'data-sharing';
  @override
  String get label => 'Data Sharing Arm';
  @override
  String get description => 'Controls categories, retention, export rights, partner transfer, and derived data.';
}

class BehaviorIntelligenceArm extends PermissionArm {
  @override
  String get id => 'behavior-intelligence';
  @override
  String get label => 'Behavior Intelligence Arm';
  @override
  String get description => 'Runs async behavior traces, signal scans, prediction hooks, and drift analysis.';
}

class PublicDataPermissionArm extends PermissionArm {
  @override
  String get id => 'public-data';
  @override
  String get label => 'Public Data Arm';
  @override
  String get description => 'Future pathway for public footprint monitoring and broker visibility.';
}
