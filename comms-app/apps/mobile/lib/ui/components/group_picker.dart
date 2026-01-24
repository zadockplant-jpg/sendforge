import 'package:flutter/material.dart';
import '../../models/group.dart';

class GroupPicker extends StatelessWidget {
  final List<Group> groups;
  final Set<String> selected;
  final ValueChanged<String> onToggle;

  const GroupPicker({
    super.key,
    required this.groups,
    required this.selected,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    return ListView(
      children: groups.map((g) {
        final checked = selected.contains(g.id);

        return CheckboxListTile(
          value: checked,
          title: Text(g.name),
          onChanged: (_) => onToggle(g.id),
        );
      }).toList(),
    );
  }
}
