import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import 'create_group_screen.dart';
import 'groups_list_screen.dart';
import 'import_contacts_screen.dart';

class GroupsScreen extends StatelessWidget {
  final AppState appState;
  const GroupsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _navButton(
            context,
            label: 'Create Group',
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => CreateGroupScreen(appState: appState),
              ),
            ),
          ),
          const SizedBox(height: 12),
          _navButton(
            context,
            label: 'Manage Groups',
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => GroupsListScreen(appState: appState),
              ),
            ),
          ),
          const SizedBox(height: 12),
          _navButton(
            context,
            label: 'Import Contacts',
            onTap: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => ImportContactsScreen(appState: appState),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _navButton(BuildContext context,
      {required String label, required VoidCallback onTap}) {
    return SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: onTap,
        child: Text(
          label,
          style: const TextStyle(fontWeight: FontWeight.w700),
        ),
      ),
    );
  }
}
