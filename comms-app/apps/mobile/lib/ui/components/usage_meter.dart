import 'package:flutter/material.dart';
import '../colors.dart';

class UsageMeter extends StatelessWidget {
  final int used;
  final int limit;

  const UsageMeter({
    super.key,
    required this.used,
    required this.limit,
  });

  @override
  Widget build(BuildContext context) {
    final pct = (used / limit).clamp(0.0, 1.0);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Monthly usage',
          style: TextStyle(fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 6),
        LinearProgressIndicator(
          value: pct,
          backgroundColor: Colors.grey.shade200,
          color: SFColors.primaryBlue,
        ),
        const SizedBox(height: 6),
        Text(
          '$used of $limit messages used',
          style: const TextStyle(color: SFColors.textMuted),
        ),
      ],
    );
  }
}
