import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/behavior_trace_result.dart';
import '../widgets/permission_sections.dart';

class BehaviorTraceReportScreen extends StatelessWidget {
  final String entityName;
  final BehaviorTraceResult result;

  const BehaviorTraceReportScreen({
    super.key,
    required this.entityName,
    required this.result,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Behavior Trace Report'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          Text(entityName, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
          const SizedBox(height: 4),
          Text('Status: ${result.statusLabel} · Confidence: ${result.confidenceLabel}', style: const TextStyle(color: SFColors.textMuted)),
          const SizedBox(height: 14),
          PermissionSectionCard(
            title: 'Summary',
            subtitle: 'Signals are protective indicators, not accusations.',
            child: Text(result.summary, style: const TextStyle(height: 1.35)),
          ),
          PermissionSectionCard(
            title: 'Observed Activity',
            child: _BulletList(items: result.observedSignals),
          ),
          PermissionSectionCard(
            title: 'Partner-Sharing Signals',
            subtitle: 'External transfer cannot be asserted without proof.',
            child: _BulletList(items: result.partnerSignals),
          ),
          PermissionSectionCard(
            title: 'Suggested Permission Changes',
            child: _BulletList(items: result.suggestedActions),
          ),
        ],
      ),
    );
  }
}

class _BulletList extends StatelessWidget {
  final List<String> items;

  const _BulletList({required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 9),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('• ', style: TextStyle(fontWeight: FontWeight.w900)),
                  Expanded(child: Text(item, style: const TextStyle(height: 1.3))),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}
