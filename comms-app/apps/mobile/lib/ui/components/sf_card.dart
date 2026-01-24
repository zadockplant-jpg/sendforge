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

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: SFColors.cardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
          if (subtitle != null) ...[
            const SizedBox(height: 6),
            Text(subtitle!, style: const TextStyle(fontSize: 13, color: SFColors.textMuted)),
          ],
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}
