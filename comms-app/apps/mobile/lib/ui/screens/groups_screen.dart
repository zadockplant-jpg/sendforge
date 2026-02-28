import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import 'create_group_screen.dart';
import 'groups_list_screen.dart';
import 'import_contacts_screen.dart';
import 'edit_contacts_screen.dart';

class GroupsScreen extends StatefulWidget {
  final AppState appState;

  const GroupsScreen({super.key, required this.appState});

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  bool _loading = true;
  String? _err;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _err = null;
    });

    try {
      await widget.appState.loadContacts();
      await widget.appState.loadGroups();
    } catch (e) {
      _err = e.toString();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: SFColors.background,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _topButtonsRow(context),
                    const SizedBox(height: 14),
                    if (_err != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: Text(
                          _err!,
                          style: const TextStyle(color: Colors.red),
                        ),
                      ),
                    Expanded(
                      child: GroupsListScreen(
                        appState: widget.appState,
                        embedMode: true,
                        onRefresh: _refresh,
                      ),
                    ),
                  ],
                ),
        ),
      ),
    );
  }

  // ✅ layout changed from vertical to horizontal
  // ✅ routing preserved
  Widget _topButtonsRow(BuildContext context) {
    final styleFilled = FilledButton.styleFrom(
      padding: const EdgeInsets.symmetric(vertical: 12),
    );
    final styleOutlined = OutlinedButton.styleFrom(
      padding: const EdgeInsets.symmetric(vertical: 12),
    );

    return Row(
      children: [
        Expanded(
          child: FilledButton(
            style: styleFilled,
            onPressed: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CreateGroupScreen(
                    appState: widget.appState,
                    type: "snapshot",
                  ),
                ),
              );
              _refresh();
            },
            child: const Text(
              'Create Group',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: FilledButton(
            style: styleFilled,
            onPressed: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CreateGroupScreen(
                    appState: widget.appState,
                    type: "meta",
                  ),
                ),
              );
              _refresh();
            },
            child: const Text(
              'Create Meta',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: OutlinedButton(
            style: styleOutlined,
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => ImportContactsScreen(appState: widget.appState),
              ),
            ),
            child: const Text(
              'Add Contacts',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12),
            ),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: OutlinedButton(
            style: styleOutlined,
            onPressed: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => EditContactsScreen(appState: widget.appState),
                ),
              );
              _refresh();
            },
            child: const Text(
              'Edit Contacts',
              textAlign: TextAlign.center,
              style: TextStyle(fontWeight: FontWeight.w800, fontSize: 12),
            ),
          ),
        ),
      ],
    );
  }
}