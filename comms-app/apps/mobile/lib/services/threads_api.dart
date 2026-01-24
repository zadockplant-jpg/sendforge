import '../core/app_state.dart';
import '../models/message.dart';

class ThreadsApi {
  final AppState appState;
  ThreadsApi(this.appState);

  /// Threads are represented by root messages
  Future<List<Message>> listThreads() async {
    return appState.threads;
  }

  Future<List<Message>> getMessages(String threadId) async {
    return appState.messagesByThread[threadId] ?? [];
  }
}
