enum Channel { sms, email }
enum ReplyMode { private, group }

class BlastDraft {
  String name = '';
  Set<Channel> channels = {Channel.sms};
  String subject = '';
  String body = '';
  ReplyMode replyMode = ReplyMode.private;

  // Later: real selectors
  List<String> groupIds = [];
  List<String> contactIds = [];
}
