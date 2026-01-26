import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../components/sf_card.dart';
import '../colors.dart';
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
        children: [
          SFCard(
            title: 'Create Group',
            subtitle: 'Start a new messaging group',
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CreateGroupScreen(appState: appState),
                ),
              ),
              child: const Text('Create Group'),
            ),
          ),
          const SizedBox(height: 16),

          SFCard(
            title: 'Manage Groups',
            subtitle: 'View and edit existing groups',
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => GroupsListScreen(appState: appState),
                ),
              ),
              child: const Text('Open Groups'),
            ),
          ),
          const SizedBox(height: 16),

          SFCard(
            title: 'Import Contacts',
            subtitle: 'Google · CSV · Device · Add manually',
            child: ElevatedButton(
              onPressed: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ImportContactsScreen(appState: appState),
                ),
              ),
              child: const Text('Open Import Menu'),
            ),
          ),
        ],
      ),
    );
  }
}
