import 'package:flutter/material.dart';

import '../../../ui/colors.dart';
import '../models/permission_record.dart';

class PermissionSectionCard extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget child;

  const PermissionSectionCard({
    super.key,
    required this.title,
    this.subtitle,
    required this.child,
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
          Text(title, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
          if (subtitle != null) ...[
            const SizedBox(height: 4),
            Text(subtitle!, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
          ],
          const SizedBox(height: 12),
          child,
        ],
      ),
    );
  }
}

class DataPermissionList extends StatelessWidget {
  final List<DataPermission> items;

  const DataPermissionList({super.key, required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(children: items.map((item) => _PermissionLine(label: item.label, detail: item.detail, status: item.status)).toList());
  }
}

class InteractionPermissionList extends StatelessWidget {
  final List<InteractionPermission> items;

  const InteractionPermissionList({super.key, required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(children: items.map((item) => _PermissionLine(label: item.label, detail: item.detail, status: item.status)).toList());
  }
}

class TimeRuleList extends StatelessWidget {
  final List<TimeRule> items;

  const TimeRuleList({super.key, required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.schedule_outlined, size: 18, color: SFColors.primaryBlue),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('${item.label}: ${item.value}', style: const TextStyle(fontWeight: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text(item.detail, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}

class CheckpointList extends StatelessWidget {
  final List<SecurityCheckpoint> items;

  const CheckpointList({super.key, required this.items});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: items
          .map(
            (item) => Padding(
              padding: const EdgeInsets.only(bottom: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(
                    item.passed ? Icons.check_circle_outline : Icons.cancel_outlined,
                    size: 19,
                    color: item.passed ? SFColors.success : SFColors.error,
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(item.label, style: const TextStyle(fontWeight: FontWeight.w700)),
                        const SizedBox(height: 2),
                        Text(item.detail, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          )
          .toList(),
    );
  }
}

class _PermissionLine extends StatelessWidget {
  final String label;
  final String detail;
  final PermissionStatus status;

  const _PermissionLine({required this.label, required this.detail, required this.status});

  Color get _color {
    switch (status) {
      case PermissionStatus.allowed:
        return SFColors.success;
      case PermissionStatus.limited:
        return SFColors.warning;
      case PermissionStatus.askFirst:
        return SFColors.primaryBlue;
      case PermissionStatus.blocked:
        return SFColors.error;
    }
  }

  String get _label {
    switch (status) {
      case PermissionStatus.allowed:
        return 'Allowed';
      case PermissionStatus.limited:
        return 'Limited';
      case PermissionStatus.askFirst:
        return 'Ask First';
      case PermissionStatus.blocked:
        return 'Blocked';
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 8,
            height: 8,
            margin: const EdgeInsets.only(top: 5),
            decoration: BoxDecoration(color: _color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(child: Text(label, style: const TextStyle(fontWeight: FontWeight.w700))),
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: _color.withOpacity(0.08),
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(_label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w800, color: _color)),
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(detail, style: const TextStyle(fontSize: 12, color: SFColors.textMuted)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
