import 'package:flutter/material.dart';

import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../models/contact.dart';
import '../../services/groups_api.dart';
import '../components/sf_card.dart';
import '../icons.dart';

class GroupDetailScreen extends StatefulWidget {
  final AppState appState;
  final Group group;

  const GroupDetailScreen({
    super.key,
    required this.appState,
    required this.group,
  });

  @override
  State<GroupDetailScreen> createState() => _GroupDetailScreenState();
}

class _GroupDetailScreenState extends State<GroupDetailScreen> {
  late Set<String> _selectedMemberIds;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _selectedMemberIds = widget.group.members.map((m) => m.id).toSet();
  }

  Future<void> _save() async {
    setState(() => _saving = true);

    final api = GroupsApi(widget.appState);
    await api.updateMembers(
      widget.group.id,
      _selectedMemberIds.toList(),
    );

    if (!mounted) return;
    Navigator.pop(context);
  }

  @override
  Widget build(BuildContext context) {
    final contacts = widget.appState.contacts;

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.group.name),
        actions: [
          TextButton(
            onPressed: _saving ? null : _save,
            child: _saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text(
                    'Save',
                    style: TextStyle(color: Colors.white),
                  ),
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: SFCard(
          title: 'Members',
          subtitle: 'Tap to add or remove members',
          child: ListView(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            children: contacts.map(_contactTile).toList(),
          ),
        ),
      ),
    );
  }

  Widget _contactTile(Contact c) {
    final selected = _selectedMemberIds.contains(c.id);

    return ListTile(
      leading: const Icon(SFIcons.contacts),
      title: Text(c.name),
      subtitle: _capabilityChips(c),
      trailing: Checkbox(
        value: selected,
        onChanged: (v) {
          setState(() {
            v == true
                ? _selectedMemberIds.add(c.id)
                : _selectedMemberIds.remove(c.id);
          });
        },
      ),
      onTap: () {
        setState(() {
          selected
              ? _selectedMemberIds.remove(c.id)
              : _selectedMemberIds.add(c.id);
        });
      },
    );
  }

  Widget _capabilityChips(Contact c) {
    final chips = <Widget>[];

    if ((c.phone ?? '').isNotEmpty) {
      chips.add(_chip('SMS', SFIcons.sms));
    }
    if ((c.email ?? '').isNotEmpty) {
      chips.add(_chip('Email', SFIcons.email));
    }

    if (chips.isEmpty) {
      chips.add(
        const Text(
          'No delivery methods',
          style: TextStyle(fontSize: 12, color: Colors.grey),
        ),
      );
    }

    return Wrap(spacing: 8, children: chips);
  }

  Widget _chip(String label, IconData icon) {
    return Chip(
      avatar: Icon(icon, size: 16),
      label: Text(label),
      visualDensity: VisualDensity.compact,
    );
  }
}
