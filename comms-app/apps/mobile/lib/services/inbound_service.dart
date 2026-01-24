import '../models/message.dart';

class InboundService {
  static List<Message> mockMessages() {
    return [
      Message(
        id: "1",
        sender: "Alice",
        body: "Can you send that again?",
        incoming: true,
        timestamp: DateTime.now().subtract(const Duration(minutes: 3)),
      ),
    ];
  }
}
