import 'package:flutter/material.dart';

import '../../../ui/colors.dart';

class PermissionSummaryCard extends StatelessWidget {
  final String label;
  final String value;
  final IconData icon;

  const PermissionSummaryCard({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: SFColors.cardBackground,
        border: Border.all(color: SFColors.cardBorder),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            height: 34,
            width: 34,
            decoration: BoxDecoration(
              color: SFColors.primaryBlue.withOpacity(0.08),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: SFColors.primaryBlue, size: 19),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(value, style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w800)),
                const SizedBox(height: 2),
                Text(label, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
