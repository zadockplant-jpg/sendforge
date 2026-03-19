// apps/mobile/lib/ui/components/sf_card.dart
import 'package:flutter/material.dart';
import '../colors.dart';

class SFCard extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget child;

  const SFCard({
    super.key,
    required this.title,
    this.subtitle,
    required this.child,
  });

  bool get _hasRealChild => child is! SizedBox;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: SFColors.cardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
          ),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(
              subtitle!,
              style: const TextStyle(fontSize: 13, color: SFColors.textMuted),
            ),
          ],
          if (_hasRealChild) ...[
            const SizedBox(height: 10),
            child,
          ],
        ],
      ),
    );
  }
}