import 'package:flutter/material.dart';
import '../../core/app_state.dart';
import '../../services/threads_api.dart';
import 'thread_detail_screen.dart';

class ThreadsScreen extends StatelessWidget {
  final AppState appState;
  const ThreadsScreen({super.key, required this.appState});

  @override
  Widget build(BuildContext context) {
    final api = ThreadsApi(appState);

    return Scaffold(
      appBar: AppBar(title: const Text('Threads')),
      body: FutureBuilder(
        future: api.listThreads(),
        builder: (context, snap) {
          if (!snap.hasData) {
            return const Center(child: CircularProgressIndicator());
          }

          final threads = snap.data!;
          if (threads.isEmpty) {
            return const Center(child: Text('No conversations yet.'));
          }

          return ListView.builder(
            itemCount: threads.length,
            itemBuilder: (_, i) {
              final m = threads[i];

              return ListTile(
                title: Text(
                  m.body,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                onTap: () {
                  Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => ThreadDetailScreen(
                        messages: [m],
                      ),
                    ),
                  );
                },
              );
            },
          );
        },
      ),
    );
  }
}
