import 'package:flutter/material.dart';

enum PermissionEntityType {
  retailer,
  healthcare,
  finance,
  education,
  logistics,
  legal,
  employer,
  utility,
  government,
  nonprofit,
  platform,
  advertising,
  marketplace,
  contractor,
  individual,
}

enum PermissionTrustState {
  trustedActive,
  limitedActive,
  timeBound,
  expiringSoon,
  revoked,
  flagged,
  unknown,
}

enum PermissionVerificationState {
  verified,
  known,
  unverified,
  flagged,
}

enum PermissionRiskLevel {
  low,
  medium,
  high,
  blocked,
}

class PermissionEntity {
  final String id;
  final String name;
  final PermissionEntityType type;
  final PermissionTrustState trustState;
  final PermissionVerificationState verificationState;
  final PermissionRiskLevel riskLevel;
  final String relationship;
  final List<String> dataSummary;
  final String accessSummary;
  final double timeRemainingPercent;
  final DateTime? expiresAt;

  const PermissionEntity({
    required this.id,
    required this.name,
    required this.type,
    required this.trustState,
    required this.verificationState,
    required this.riskLevel,
    required this.relationship,
    required this.dataSummary,
    required this.accessSummary,
    required this.timeRemainingPercent,
    this.expiresAt,
  });

  String get typeLabel {
    switch (type) {
      case PermissionEntityType.retailer:
        return 'Retail';
      case PermissionEntityType.healthcare:
        return 'Healthcare';
      case PermissionEntityType.finance:
        return 'Finance';
      case PermissionEntityType.education:
        return 'Education';
      case PermissionEntityType.logistics:
        return 'Logistics';
      case PermissionEntityType.legal:
        return 'Legal';
      case PermissionEntityType.employer:
        return 'Employer';
      case PermissionEntityType.utility:
        return 'Utility';
      case PermissionEntityType.government:
        return 'Government';
      case PermissionEntityType.nonprofit:
        return 'Nonprofit';
      case PermissionEntityType.platform:
        return 'Platform';
      case PermissionEntityType.advertising:
        return 'Advertising';
      case PermissionEntityType.marketplace:
        return 'Marketplace';
      case PermissionEntityType.contractor:
        return 'Contractor';
      case PermissionEntityType.individual:
        return 'Individual';
    }
  }

  String get verificationLabel {
    switch (verificationState) {
      case PermissionVerificationState.verified:
        return 'Verified';
      case PermissionVerificationState.known:
        return 'Known';
      case PermissionVerificationState.unverified:
        return 'Unverified';
      case PermissionVerificationState.flagged:
        return 'Flagged';
    }
  }

  String get trustLabel {
    switch (trustState) {
      case PermissionTrustState.trustedActive:
        return 'Trusted Active';
      case PermissionTrustState.limitedActive:
        return 'Limited Active';
      case PermissionTrustState.timeBound:
        return 'Time-Bound';
      case PermissionTrustState.expiringSoon:
        return 'Expiring Soon';
      case PermissionTrustState.revoked:
        return 'Revoked';
      case PermissionTrustState.flagged:
        return 'Flagged';
      case PermissionTrustState.unknown:
        return 'Unknown';
    }
  }

  IconData get icon {
    switch (trustState) {
      case PermissionTrustState.trustedActive:
        return Icons.verified_user_outlined;
      case PermissionTrustState.limitedActive:
        return Icons.shield_outlined;
      case PermissionTrustState.timeBound:
        return Icons.hourglass_bottom_outlined;
      case PermissionTrustState.expiringSoon:
        return Icons.schedule_outlined;
      case PermissionTrustState.revoked:
        return Icons.block_outlined;
      case PermissionTrustState.flagged:
        return Icons.report_gmailerrorred_outlined;
      case PermissionTrustState.unknown:
        return Icons.radio_button_unchecked;
    }
  }
}
