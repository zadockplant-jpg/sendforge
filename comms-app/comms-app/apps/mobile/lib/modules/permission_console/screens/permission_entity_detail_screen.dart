import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/behavior_trace_result.dart';
import '../models/permission_entity.dart';
import '../models/permission_record.dart';
import '../services/behavior_trace_service.dart';
import '../widgets/behavior_trace_card.dart';
import '../widgets/permission_sections.dart';
import '../widgets/permission_time_ring.dart';
import 'behavior_trace_report_screen.dart';

class PermissionEntityDetailScreen extends StatefulWidget {
  final PermissionEntity entity;
  final PermissionRecord record;
  final BehaviorTraceResult? initialTrace;
  final BehaviorTraceService traceService;

  const PermissionEntityDetailScreen({
    super.key,
    required this.entity,
    required this.record,
    required this.initialTrace,
    required this.traceService,
  });

  @override
  State<PermissionEntityDetailScreen> createState() => _PermissionEntityDetailScreenState();
}

class _PermissionEntityDetailScreenState extends State<PermissionEntityDetailScreen> {
  bool _traceRunning = false;
  BehaviorTraceResult? _trace;

  @override
  void initState() {
    super.initState();
    _trace = widget.initialTrace;
  }

  Future<void> _runTrace() async {
    setState(() => _traceRunning = true);
    final result = await widget.traceService.runTrace(widget.entity.id);
    if (!mounted) return;
    setState(() {
      _traceRunning = false;
      _trace = result;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text('Behavior Trace complete for ${widget.entity.name}'),
        action: SnackBarAction(label: 'View', onPressed: _viewReport),
      ),
    );
  }

  void _viewReport() {
    final result = _trace;
    if (result == null) return;
    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => BehaviorTraceReportScreen(
          entityName: widget.entity.name,
          result: result,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Permission Contract')),
      body: ListView(
        padding: const EdgeInsets.all(14),
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: SFColors.cardBackground,
              border: Border.all(color: SFColors.cardBorder),
              borderRadius: BorderRadius.circular(18),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                PermissionTimeRing(entity: widget.entity, size: 58),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(widget.entity.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900)),
                      const SizedBox(height: 3),
                      Text('${widget.entity.typeLabel} · ${widget.entity.verificationLabel}', style: const TextStyle(color: SFColors.textMuted)),
                      const SizedBox(height: 8),
                      Text('Relationship: ${widget.entity.relationship}', style: const TextStyle(fontWeight: FontWeight.w700)),
                      const SizedBox(height: 3),
                      Text('Current State: ${widget.entity.trustLabel}', style: const TextStyle(color: SFColors.textMuted)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          BehaviorTraceCard(
            running: _traceRunning,
            result: _trace,
            onRun: _traceRunning ? () {} : _runTrace,
            onViewReport: _viewReport,
          ),
          PermissionSectionCard(
            title: 'Data Access',
            subtitle: 'What this entity may receive, hold, infer, or request.',
            child: DataPermissionList(items: widget.record.dataPermissions),
          ),
          PermissionSectionCard(
            title: 'Interaction Rights',
            subtitle: 'What this entity may do in relation to the client.',
            child: InteractionPermissionList(items: widget.record.interactionPermissions),
          ),
          PermissionSectionCard(
            title: 'Time Rules',
            subtitle: 'Access is temporary unless continuously justified.',
            child: TimeRuleList(items: widget.record.timeRules),
          ),
          PermissionSectionCard(
            title: 'Security Checkpoints',
            subtitle: 'Every pathway arm must pass gates before action is allowed.',
            child: CheckpointList(items: widget.record.checkpoints),
          ),
          PermissionSectionCard(
            title: 'History',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: widget.record.history
                  .map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(bottom: 9),
                      child: Text(item, style: const TextStyle(height: 1.3)),
                    ),
                  )
                  .toList(),
            ),
          ),
        ],
      ),
    );
  }
}
