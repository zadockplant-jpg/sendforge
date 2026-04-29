import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_entity.dart';
import 'permission_time_ring.dart';

class PermissionEntityRow extends StatelessWidget {
  final PermissionEntity entity;
  final VoidCallback onTap;

  const PermissionEntityRow({
    super.key,
    required this.entity,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(16),
      child: Container(
        padding: const EdgeInsets.all(12),
        margin: const EdgeInsets.only(bottom: 10),
        decoration: BoxDecoration(
          color: SFColors.cardBackground,
          border: Border.all(color: SFColors.cardBorder),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          children: [
            PermissionTimeRing(entity: entity),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(entity.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15)),
                  const SizedBox(height: 3),
                  Text(
                    '${entity.typeLabel} · ${entity.verificationLabel}',
                    style: const TextStyle(color: SFColors.textMuted, fontSize: 12),
                  ),
                  const SizedBox(height: 7),
                  Text(
                    entity.dataSummary.isEmpty ? 'Data: none granted' : 'Data: ${entity.dataSummary.join(', ')}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: SFColors.textPrimary),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    'Access: ${entity.accessSummary}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontSize: 12, color: SFColors.textMuted),
                  ),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, color: SFColors.textMuted),
          ],
        ),
      ),
    );
  }
}
