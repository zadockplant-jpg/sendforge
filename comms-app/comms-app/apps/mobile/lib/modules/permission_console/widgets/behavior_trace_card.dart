import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/behavior_trace_result.dart';

class BehaviorTraceCard extends StatelessWidget {
  final bool running;
  final BehaviorTraceResult? result;
  final VoidCallback onRun;
  final VoidCallback? onViewReport;

  const BehaviorTraceCard({
    super.key,
    required this.running,
    required this.result,
    required this.onRun,
    this.onViewReport,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: SFColors.cardBackground,
        border: Border.all(color: SFColors.cardBorder),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.radar_outlined, color: SFColors.primaryBlue),
              const SizedBox(width: 8),
              const Expanded(child: Text('Behavior Trace', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800))),
              if (running)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          const SizedBox(height: 10),
          if (running) ...[
            const Text('Trace running.', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 3),
            const Text(
              'Checking permission usage, partner signals, public pathways, and contract drift. You’ll be notified when complete.',
              style: TextStyle(fontSize: 12, color: SFColors.textMuted),
            ),
          ] else if (result != null) ...[
            Text('Status: ${result!.statusLabel} · Confidence: ${result!.confidenceLabel}', style: const TextStyle(fontWeight: FontWeight.w800)),
            const SizedBox(height: 4),
            Text(result!.summary, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
            const SizedBox(height: 10),
            Row(
              children: [
                OutlinedButton.icon(
                  onPressed: onRun,
                  icon: const Icon(Icons.refresh, size: 17),
                  label: const Text('Run New Trace'),
                ),
                const SizedBox(width: 8),
                TextButton(onPressed: onViewReport, child: const Text('View Report')),
              ],
            ),
          ] else ...[
            const Text('No trace run yet.', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 3),
            const Text(
              'Start an async behavior check against this entity. Results are framed as signals, not accusations.',
              style: TextStyle(fontSize: 12, color: SFColors.textMuted),
            ),
            const SizedBox(height: 10),
            FilledButton.icon(
              onPressed: onRun,
              icon: const Icon(Icons.play_arrow),
              label: const Text('Run Behavior Trace'),
            ),
          ],
        ],
      ),
    );
  }
}
