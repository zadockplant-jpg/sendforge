enum ReplyMode { private, group }

class GroupMemberDraft {
  final String id;
  final String display;
  final bool sms;
  final bool email;

  GroupMemberDraft({
    required this.id,
    required this.display,
    required this.sms,
    required this.email,
  });
}

class GroupDraft {
  String name;
  ReplyMode replyMode;
  List<GroupMemberDraft> members;

  GroupDraft({
    this.name = "",
    this.replyMode = ReplyMode.private,
    List<GroupMemberDraft>? members,
  }) : members = members ?? [];
}
