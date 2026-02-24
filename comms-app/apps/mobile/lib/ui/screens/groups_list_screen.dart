// comms-app/apps/mobile/lib/ui/screens/groups_list_screen.dart
import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../models/group.dart';
import '../../services/groups_api.dart';
import '../components/sf_card.dart';
import 'group_detail_screen.dart';

class GroupsListScreen extends StatefulWidget {
  final AppState appState;

  /// If true, this screen renders just the list (no scaffold),
  /// so GroupsScreen can embed it under the buttons.
  final bool embedMode;

  final Future<void> Function()? onRefresh;

  const GroupsListScreen({
    super.key,
    required this.appState,
    this.embedMode = false,
    this.onRefresh,
  });

  @override
  State<GroupsListScreen> createState() => _GroupsListScreenState();
}

class _GroupsListScreenState extends State<GroupsListScreen> {
  bool busy = true;
  List<Group> groups = [];
  String? error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      busy = true;
      error = null;
    });

    try {
      final api = GroupsApi(widget.appState);
      final data = await api.list();

      // keep AppState in sync
      widget.appState.groups
        ..clear()
        ..addAll(data);

      if (!mounted) return;
      setState(() {
        groups = data;
        busy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        error = e.toString();
        busy = false;
      });
    }
  }

  Widget _content() {
    if (busy) return const Center(child: CircularProgressIndicator());
    if (error != null) return Center(child: Text(error!, style: const TextStyle(color: Colors.red)));
    if (groups.isEmpty) return const Center(child: Text("No groups yet."));

    return RefreshIndicator(
      onRefresh: () async {
        await _load();
        if (widget.onRefresh != null) await widget.onRefresh!();
      },
      child: ListView.separated(
        itemCount: groups.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (context, i) {
          final g = groups[i];
          final subtitle = g.type == "meta"
              ? '${g.memberCount} members (dynamic)'
              : '${g.memberCount} members';

          return SFCard(
            title: g.name,
            subtitle: subtitle,
            child: Row(
              children: [
                Expanded(
                  child: FilledButton(
                    onPressed: () async {
                      await Navigator.push(
                        context,
                        MaterialPageRoute(
                          builder: (_) => GroupDetailScreen(
                            appState: widget.appState,
                            group: g,
                          ),
                        ),
                      );

                      // Reload so member count stays fresh even if user hit back fast
                      _load();
                    },
                    child: const Text('Open', style: TextStyle(fontWeight: FontWeight.w800)),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.embedMode) return _content();

    return Scaffold(
      appBar: AppBar(title: const Text('Groups')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: _content(),
      ),
    );
  }
}