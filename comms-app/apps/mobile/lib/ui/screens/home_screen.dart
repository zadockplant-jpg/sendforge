import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../colors.dart';
import '../icons.dart';
import '../components/sf_top_tab_bar.dart';
import 'create_blast_screen.dart';
import 'threads_screen.dart';
import 'groups_screen.dart';
import 'settings_screen.dart';

enum HomeTab { blast, threads, groups }

class HomeScreen extends StatefulWidget {
  final AppState appState;
  const HomeScreen({super.key, required this.appState});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  HomeTab _tab = HomeTab.blast;

  Widget _buildBody() {
    switch (_tab) {
      case HomeTab.threads:
        return ThreadsScreen(appState: widget.appState);
      case HomeTab.groups:
        return GroupsScreen(appState: widget.appState);
      case HomeTab.blast:
      default:
        return CreateBlastScreen(appState: widget.appState);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        elevation: 0,
        flexibleSpace: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(
              colors: [
                SFColors.headerBlueDark,
                SFColors.headerBlueLight,
              ],
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
            ),
          ),
        ),
        title: Row(
          children: [
            const Icon(SFIcons.send, color: Colors.white),
            const SizedBox(width: 8),
            const Text(
              'SendForge',
              style: TextStyle(fontWeight: FontWeight.w700),
            ),
          ],
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => SettingsScreen(appState: widget.appState),
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          SFTabBar(
            current: _tab,
            onChanged: (t) => setState(() => _tab = t),
          ),
          Expanded(child: _buildBody()),
        ],
      ),
    );
  }
}
