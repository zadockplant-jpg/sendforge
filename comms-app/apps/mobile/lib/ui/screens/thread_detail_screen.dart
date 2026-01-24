import 'package:flutter/material.dart';
import '../../models/message.dart';

class ThreadDetailScreen extends StatelessWidget {
  final List<Message> messages;

  const ThreadDetailScreen({
    super.key,
    required this.messages,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Thread')),
      body: messages.isEmpty
          ? const Center(child: Text('No messages yet.'))
          : ListView.builder(
              itemCount: messages.length,
              itemBuilder: (_, i) {
                final m = messages[i];
                return ListTile(
                  title: Text(m.body),
                );
              },
            ),
    );
  }
}
