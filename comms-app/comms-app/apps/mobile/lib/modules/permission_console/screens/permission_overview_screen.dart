import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_entity.dart';
import '../widgets/permission_summary_card.dart';
import '../widgets/permission_entity_row.dart';

class PermissionOverviewScreen extends StatelessWidget {
  final List<PermissionEntity> entities;
  final ValueChanged<PermissionEntity> onEntitySelected;

  const PermissionOverviewScreen({
    super.key,
    required this.entities,
    required this.onEntitySelected,
  });

  @override
  Widget build(BuildContext context) {
    final timeLimited = entities.where((e) => e.timeRemainingPercent > 0 && e.timeRemainingPercent < 1).length;
    final flagged = entities.where((e) => e.trustState == PermissionTrustState.flagged || e.trustState == PermissionTrustState.revoked).length;
    final expiring = entities.where((e) => e.timeRemainingPercent > 0 && e.timeRemainingPercent < 0.4).length;

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        const Text('Permission Console', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
        const SizedBox(height: 4),
        const Text(
          'Control the user’s digital fingerprint across companies, people, services, and future SendForge arms.',
          style: TextStyle(color: SFColors.textMuted),
        ),
        const SizedBox(height: 14),
        GridView.count(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          crossAxisCount: MediaQuery.of(context).size.width > 650 ? 4 : 2,
          childAspectRatio: 2.4,
          mainAxisSpacing: 10,
          crossAxisSpacing: 10,
          children: [
            PermissionSummaryCard(label: 'Governed Entities', value: '${entities.length}', icon: Icons.account_tree_outlined),
            PermissionSummaryCard(label: 'Time-Limited', value: '$timeLimited', icon: Icons.hourglass_bottom_outlined),
            PermissionSummaryCard(label: 'Expiring Soon', value: '$expiring', icon: Icons.schedule_outlined),
            PermissionSummaryCard(label: 'Flagged / Blocked', value: '$flagged', icon: Icons.warning_amber_outlined),
          ],
        ),
        const SizedBox(height: 16),
        const Text('Needs attention', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
        const SizedBox(height: 10),
        ...entities
            .where((entity) => entity.trustState == PermissionTrustState.timeBound || entity.trustState == PermissionTrustState.flagged || entity.trustState == PermissionTrustState.revoked)
            .map((entity) => PermissionEntityRow(entity: entity, onTap: () => onEntitySelected(entity))),
      ],
    );
  }
}
