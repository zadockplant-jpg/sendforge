import '../models/permission_entity.dart';
import '../models/permission_record.dart';
import '../models/behavior_trace_result.dart';

class MockPermissionRepository {
  final DateTime _now = DateTime.now();

  List<PermissionEntity> loadEntities() {
    return [
      PermissionEntity(
        id: 'acme-health',
        name: 'Acme Health',
        type: PermissionEntityType.healthcare,
        trustState: PermissionTrustState.trustedActive,
        verificationState: PermissionVerificationState.verified,
        riskLevel: PermissionRiskLevel.medium,
        relationship: 'Active patient portal',
        dataSummary: const ['Identity', 'Billing', 'Appointments'],
        accessSummary: 'Active · expires in 12 days',
        timeRemainingPercent: 0.78,
        expiresAt: _now.add(const Duration(days: 12)),
      ),
      PermissionEntity(
        id: 'retailco',
        name: 'RetailCo',
        type: PermissionEntityType.retailer,
        trustState: PermissionTrustState.timeBound,
        verificationState: PermissionVerificationState.known,
        riskLevel: PermissionRiskLevel.medium,
        relationship: 'Recent purchase',
        dataSummary: const ['Contact', 'Purchase History'],
        accessSummary: 'Decaying · promos expire in 3 days',
        timeRemainingPercent: 0.36,
        expiresAt: _now.add(const Duration(days: 3)),
      ),
      PermissionEntity(
        id: 'metro-finance',
        name: 'Metro Finance',
        type: PermissionEntityType.finance,
        trustState: PermissionTrustState.limitedActive,
        verificationState: PermissionVerificationState.verified,
        riskLevel: PermissionRiskLevel.low,
        relationship: 'Account services',
        dataSummary: const ['Identity', 'Financial', 'Support History'],
        accessSummary: 'Limited · ask before renewal',
        timeRemainingPercent: 0.62,
        expiresAt: _now.add(const Duration(days: 21)),
      ),
      PermissionEntity(
        id: 'admesh',
        name: 'AdMesh Partners',
        type: PermissionEntityType.advertising,
        trustState: PermissionTrustState.flagged,
        verificationState: PermissionVerificationState.flagged,
        riskLevel: PermissionRiskLevel.high,
        relationship: 'Partner signal only',
        dataSummary: const ['Behavioral', 'Derived Profile'],
        accessSummary: 'Blocked · elevated partner-sharing signals',
        timeRemainingPercent: 0.0,
      ),
      PermissionEntity(
        id: 'jordan-wells',
        name: 'Jordan Wells',
        type: PermissionEntityType.individual,
        trustState: PermissionTrustState.limitedActive,
        verificationState: PermissionVerificationState.known,
        riskLevel: PermissionRiskLevel.low,
        relationship: 'Direct exchange',
        dataSummary: const ['Phone', 'Direct Messages'],
        accessSummary: 'Direct only · no sharing arms',
        timeRemainingPercent: 1.0,
      ),
      PermissionEntity(
        id: 'unknown-sender',
        name: 'Unknown Sender',
        type: PermissionEntityType.platform,
        trustState: PermissionTrustState.revoked,
        verificationState: PermissionVerificationState.unverified,
        riskLevel: PermissionRiskLevel.blocked,
        relationship: 'Unverified inbound actor',
        dataSummary: const [],
        accessSummary: 'Revoked · failed verification checkpoint',
        timeRemainingPercent: 0.0,
      ),
    ];
  }

  PermissionRecord loadRecord(String entityId) {
    switch (entityId) {
      case 'retailco':
        return const PermissionRecord(
          entityId: 'retailco',
          dataPermissions: [
            DataPermission(label: 'Contact Info', status: PermissionStatus.allowed, detail: '30-day post-purchase window'),
            DataPermission(label: 'Purchase History', status: PermissionStatus.limited, detail: 'Expires in 7 days'),
            DataPermission(label: 'Behavioral Data', status: PermissionStatus.askFirst, detail: 'Request only with stated purpose'),
            DataPermission(label: 'Derived Profile', status: PermissionStatus.blocked, detail: 'No inference expansion'),
          ],
          interactionPermissions: [
            InteractionPermission(label: 'Transactional Alerts', status: PermissionStatus.allowed, detail: 'Order and delivery only'),
            InteractionPermission(label: 'Support Replies', status: PermissionStatus.allowed, detail: 'Active support window'),
            InteractionPermission(label: 'Promotions', status: PermissionStatus.limited, detail: 'Expires in 3 days'),
            InteractionPermission(label: 'Partner Handoff', status: PermissionStatus.blocked, detail: 'No transfer without ask-first approval'),
          ],
          timeRules: [
            TimeRule(label: 'Primary Access', value: '30 days', detail: 'Created from recent purchase'),
            TimeRule(label: 'After Expiration', value: 'Alerts only', detail: 'Promotions and behavioral data downgrade automatically'),
            TimeRule(label: 'Renewal', value: 'Ask first', detail: 'No silent renewal'),
            TimeRule(label: 'Cooldown', value: '48 hours', detail: 'No promotions after purchase events'),
          ],
          checkpoints: [
            SecurityCheckpoint(label: 'Entity recognized', passed: true, detail: 'Known retailer profile'),
            SecurityCheckpoint(label: 'Time window valid', passed: true, detail: 'Primary window is still open'),
            SecurityCheckpoint(label: 'Purpose declared', passed: true, detail: 'Order and support purposes available'),
            SecurityCheckpoint(label: 'Partner transfer allowed', passed: false, detail: 'Partner handoff is blocked'),
          ],
          history: [
            'Today · Behavior trace completed with caution status',
            'Yesterday · Promotional access entered decay window',
            'Apr 22 · Purchase-history access limited to 7 days',
            'Apr 20 · Transactional alerts allowed',
          ],
        );
      case 'admesh':
        return const PermissionRecord(
          entityId: 'admesh',
          dataPermissions: [
            DataPermission(label: 'Behavioral Data', status: PermissionStatus.blocked, detail: 'No direct grant'),
            DataPermission(label: 'Derived Profile', status: PermissionStatus.blocked, detail: 'Inference expansion blocked'),
            DataPermission(label: 'Contact Info', status: PermissionStatus.blocked, detail: 'No contact grant'),
          ],
          interactionPermissions: [
            InteractionPermission(label: 'Direct Contact', status: PermissionStatus.blocked, detail: 'No active relationship'),
            InteractionPermission(label: 'Partner Handoff', status: PermissionStatus.blocked, detail: 'Flagged path'),
            InteractionPermission(label: 'Automated Agent Contact', status: PermissionStatus.blocked, detail: 'Requires verified requestor'),
          ],
          timeRules: [
            TimeRule(label: 'Primary Access', value: 'None', detail: 'No permission contract'),
            TimeRule(label: 'After Detection', value: 'Block', detail: 'Default deny until explicitly approved'),
          ],
          checkpoints: [
            SecurityCheckpoint(label: 'Entity verified', passed: false, detail: 'Partner identity not established'),
            SecurityCheckpoint(label: 'Permission exists', passed: false, detail: 'No active user grant'),
            SecurityCheckpoint(label: 'Risk acceptable', passed: false, detail: 'Elevated partner-sharing signals'),
          ],
          history: [
            'Today · Partner-sharing signal detected',
            'Today · Access remains blocked',
          ],
        );
      default:
        return const PermissionRecord(
          entityId: 'default',
          dataPermissions: [
            DataPermission(label: 'Identity', status: PermissionStatus.allowed, detail: 'Scoped relationship data'),
            DataPermission(label: 'Contact Info', status: PermissionStatus.limited, detail: 'No export without renewal'),
            DataPermission(label: 'Location', status: PermissionStatus.blocked, detail: 'No location grant'),
            DataPermission(label: 'Derived Profile', status: PermissionStatus.blocked, detail: 'No inference expansion'),
          ],
          interactionPermissions: [
            InteractionPermission(label: 'Transactional Alerts', status: PermissionStatus.allowed, detail: 'Operational messages only'),
            InteractionPermission(label: 'Support Replies', status: PermissionStatus.allowed, detail: 'Active relationship'),
            InteractionPermission(label: 'Promotions', status: PermissionStatus.blocked, detail: 'Marketing not granted'),
            InteractionPermission(label: 'Data Requests', status: PermissionStatus.askFirst, detail: 'User approval required'),
          ],
          timeRules: [
            TimeRule(label: 'Primary Access', value: '30 days', detail: 'Time-limited by default'),
            TimeRule(label: 'After Expiration', value: 'Downgrade', detail: 'Reduce to required alerts only'),
            TimeRule(label: 'Renewal', value: 'Ask first', detail: 'No silent extension'),
            TimeRule(label: 'Decay', value: 'Inactivity based', detail: 'Access weakens without active relationship'),
          ],
          checkpoints: [
            SecurityCheckpoint(label: 'Entity verified', passed: true, detail: 'Verified or known entity'),
            SecurityCheckpoint(label: 'Permission exists', passed: true, detail: 'Contract is present'),
            SecurityCheckpoint(label: 'Time window valid', passed: true, detail: 'Access has not expired'),
            SecurityCheckpoint(label: 'Partner transfer allowed', passed: false, detail: 'Blocked unless separately approved'),
          ],
          history: [
            'Today · Permission contract reviewed',
            'Apr 22 · Time limit applied',
            'Apr 20 · Data categories scoped',
          ],
        );
    }
  }

  BehaviorTraceResult loadLastTrace(String entityId) {
    return BehaviorTraceResult(
      entityId: entityId,
      statusLabel: entityId == 'admesh' ? 'Elevated' : 'Caution',
      confidenceLabel: entityId == 'admesh' ? 'Medium' : 'Moderate',
      summary: entityId == 'admesh'
          ? 'Signals suggest elevated partner-sharing risk. No direct accusation is made from available signals.'
          : 'Observed behavior mostly matches the permission contract, with partner-routing signals that deserve review.',
      observedSignals: const [
        'SendForge-controlled actions matched active permission windows',
        'No direct proof of data resale detected',
        'Some activity routes through external service domains',
      ],
      partnerSignals: const [
        'Privacy language allows selected service partners',
        'Marketing or analytics vendor patterns may be present',
        'External transfer could not be fully verified',
      ],
      suggestedActions: const [
        'Keep partner handoff blocked',
        'Use ask-first renewal for data requests',
        'Shorten behavioral-data access windows',
      ],
      completedAt: DateTime.now().subtract(const Duration(days: 2)),
    );
  }
}
