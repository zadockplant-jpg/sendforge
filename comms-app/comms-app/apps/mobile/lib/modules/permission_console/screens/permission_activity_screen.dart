import 'package:flutter/material.dart';

import '../../../ui/colors.dart';

class PermissionActivityScreen extends StatelessWidget {
  const PermissionActivityScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final items = const [
      ['RetailCo', 'Behavior trace completed · Caution'],
      ['Acme Health', 'Billing access reviewed · 30-day window remains active'],
      ['Unknown Sender', 'Interaction blocked · failed verification checkpoint'],
      ['Metro Finance', 'Ask-first renewal rule applied'],
      ['AdMesh Partners', 'Partner-sharing signal detected · access remains blocked'],
    ];

    return ListView(
      padding: const EdgeInsets.all(14),
      children: [
        const Text('Activity', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
        const SizedBox(height: 4),
        const Text('Permission changes, trace jobs, checkpoint events, and blocked pathways.', style: TextStyle(color: SFColors.textMuted)),
        const SizedBox(height: 14),
        ...items.map(
          (item) => Container(
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(13),
            decoration: BoxDecoration(
              color: SFColors.cardBackground,
              border: Border.all(color: SFColors.cardBorder),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(Icons.timeline_outlined, color: SFColors.primaryBlue),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(item[0], style: const TextStyle(fontWeight: FontWeight.w800)),
                      const SizedBox(height: 2),
                      Text(item[1], style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
