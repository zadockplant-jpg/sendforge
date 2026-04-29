import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_entity.dart';
import '../widgets/permission_summary_card.dart';
import '../widgets/permission_sections.dart';

class PermissionAnalyticsScreen extends StatelessWidget {
  final List<PermissionEntity> entities;

  const PermissionAnalyticsScreen({super.key, required this.entities});

  @override
  Widget build(BuildContext context) {
    final sensitive = entities.where((e) => e.dataSummary.any((d) => ['Financial', 'Health', 'Behavioral', 'Derived Profile'].contains(d))).length;
    final blocked = entities.where((e) => e.trustState == PermissionTrustState.revoked || e.trustState == PermissionTrustState.flagged).length;
    final timeLimited = entities.where((e) => e.timeRemainingPercent > 0 && e.timeRemainingPercent < 1).length;

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        const Text('Control Analytics', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
        const SizedBox(height: 4),
        const Text('Exposure, permission posture, behavior drift, and blocked pathways.', style: TextStyle(color: SFColors.textMuted)),
        const SizedBox(height: 14),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: MediaQuery.of(context).size.width > 650 ? 4 : 2,
          childAspectRatio: 2.4,
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          children: [
            PermissionSummaryCard(label: 'Sensitive Access', value: '$sensitive', icon: Icons.fingerprint_outlined),
            PermissionSummaryCard(label: 'Time-Limited', value: '$timeLimited', icon: Icons.hourglass_bottom_outlined),
            PermissionSummaryCard(label: 'Blocked / Flagged', value: '$blocked', icon: Icons.block_outlined),
            const PermissionSummaryCard(label: 'Trace Jobs', value: '1', icon: Icons.radar_outlined),
          ],
        ),
        const SizedBox(height: 16),
        PermissionSectionCard(
          title: 'Exposure by Data Type',
          child: Column(
            children: const [
              _MetricLine(label: 'Identity', value: 4),
              _MetricLine(label: 'Contact Info', value: 5),
              _MetricLine(label: 'Financial', value: 1),
              _MetricLine(label: 'Health', value: 1),
              _MetricLine(label: 'Behavioral / Derived', value: 1),
            ],
          ),
        ),
        PermissionSectionCard(
          title: 'Behavior Drift',
          subtitle: 'Future engine arm: detects when company behavior moves away from the permission contract.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: const [
              Text('RetailCo · partner-routing signals increased since last trace'),
              SizedBox(height: 8),
              Text('AdMesh Partners · remains blocked due to elevated partner-sharing risk'),
              SizedBox(height: 8),
              Text('Acme Health · stable behavior, no drift detected'),
            ],
          ),
        ),
      ],
    );
  }
}

class _MetricLine extends StatelessWidget {
  final String label;
  final int value;

  const _MetricLine({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        children: [
          Expanded(child: Text(label, style: const TextStyle(fontWeight: FontWeight.w700))),
          Text('$value entities', style: const TextStyle(color: SFColors.textMuted)),
        ],
      ),
    );
  }
}
