// comms-app/apps/mobile/lib/ui/screens/groups_screen.dart
import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import 'create_group_screen.dart';
import 'groups_list_screen.dart';
// You can wire ManageContactsScreen later once you paste it; for now we keep existing ImportContactsScreen.
import 'import_contacts_screen.dart';

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
                    _topButtons(context),
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

  Widget _topButtons(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        FilledButton(
          onPressed: () async {
            await Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => CreateGroupScreen(appState: widget.appState),
              ),
            );
            _refresh();
          },
          child: const Text('Create Group', style: TextStyle(fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 10),
        FilledButton(
          onPressed: () async {
            await Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => CreateGroupScreen(appState: widget.appState, type: "meta"),
              ),
            );
            _refresh();
          },
          child: const Text('Create Meta Group', style: TextStyle(fontWeight: FontWeight.w800)),
        ),
        const SizedBox(height: 10),
        OutlinedButton(
          onPressed: () => Navigator.push(
            context,
            MaterialPageRoute(
              builder: (_) => ImportContactsScreen(appState: widget.appState),
            ),
          ),
          child: const Text('Manage Contacts', style: TextStyle(fontWeight: FontWeight.w800)),
        ),
      ],
    );
  }
}