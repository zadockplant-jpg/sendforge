import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../icons.dart';
import '../components/sf_list_tile.dart';
import 'groups_screen.dart';
import 'create_blast_screen.dart';
import 'contacts_import_screen.dart';
import 'settings_screen.dart';
import 'threads_screen.dart';

class HomeScreen extends StatelessWidget {
  final AppState appState;
  const HomeScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('SendForge')),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            SFListTile(
              title: 'Create Blast',
              subtitle: 'Send SMS + Email together',
              icon: SFIcons.blast,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => CreateBlastScreen(appState: appState),
                ),
              ),
            ),
            const SizedBox(height: 12),

            SFListTile(
              title: 'Threads',
              subtitle: 'Replies & conversations',
              icon: SFIcons.chat,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ThreadsScreen(appState: appState),
                ),
              ),
            ),

            SFListTile(
              title: 'Plans & Billing',
              subtitle: 'View plans and limits',
              icon: SFIcons.settings,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(appState: appState),

                ),
              ),
            ),

            const SizedBox(height: 12),

            SFListTile(
              title: 'Manage Groups',
              subtitle: 'Mixed SMS + Email members',
              icon: SFIcons.groups,
              iconColor: SFColors.secondarySlate,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => GroupsScreen(appState: appState),
                ),
              ),
            ),

            const SizedBox(height: 12),

            SFListTile(
              title: 'Import Contacts',
              subtitle: 'Bring in existing contacts',
              icon: SFIcons.imports,
              iconColor: SFColors.secondarySlate,
              onTap: () => Navigator.push(
                context,
                MaterialPageRoute(
                  builder: (_) => ContactsImportScreen(appState: appState),
                ),
              ),
            ),

            const Spacer(),

            const Text(
              'MVP: UI first. Wiring next.',
              style: TextStyle(color: SFColors.textMuted),
            ),
          ],
        ),
      ),
    );
  }
}
