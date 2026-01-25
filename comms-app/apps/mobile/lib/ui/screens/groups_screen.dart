import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../services/groups_api.dart';
import '../components/sf_card.dart';
import '../icons.dart';
import 'group_detail_screen.dart';
import 'create_group_screen.dart';

class GroupsScreen extends StatefulWidget {
  final AppState appState;
  const GroupsScreen({super.key, required this.appState});

  @override
  State<GroupsScreen> createState() => _GroupsScreenState();
}

class _GroupsScreenState extends State<GroupsScreen> {
  bool busy = true;
  List<Group> groups = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => busy = true);
    final api = GroupsApi(widget.appState);
    final data = await api.list();
    if (!mounted) return;
    setState(() {
      groups = data;
      busy = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Groups'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            tooltip: 'Create Group',
            onPressed: () async {
              await Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CreateGroupScreen(appState: widget.appState),
                ),
              );
              _load();
            },
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: busy
            ? const Center(child: CircularProgressIndicator())
            : ListView.separated(
                itemCount: groups.length,
                separatorBuilder: (_, __) => const SizedBox(height: 12),
                itemBuilder: (context, i) {
                  final g = groups[i];
                  return SFCard(
                    title: g.name,
                    subtitle: '${g.members.length} members',
                    child: Row(
                      children: [
                        Expanded(
                          child: FilledButton.icon(
                            onPressed: () => Navigator.push(
                              context,
                              MaterialPageRoute(
                                builder: (_) => GroupDetailScreen(
                                  appState: widget.appState,
                                  group: g,
                                ),
                              ),
                            ),
                            // ✅ FIX: remove const to avoid “Not a constant expression”
                            icon: Icon(SFIcons.groups),
                            label: const Text('Open'),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
      ),
    );
  }
}
