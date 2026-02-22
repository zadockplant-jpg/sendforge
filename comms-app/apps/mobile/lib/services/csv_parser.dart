// comms-app/apps/mobile/lib/services/csv_parser.dart
import 'dart:convert';
import 'dart:typed_data';
import 'dart:io' show File;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:csv/csv.dart';
import 'package:file_picker/file_picker.dart';

import '../models/contact.dart';

class CsvParser {
  /// Picks a CSV, parses it client-side, returns contacts.
  /// Supports Desktop/Mobile (path) AND Web (bytes).
  static Future<List<Contact>> pickAndParseCsv() async {
    final res = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['csv'],
      // Web: must use bytes. Desktop: path is fine.
      withData: kIsWeb,
    );

    if (res == null || res.files.isEmpty) return [];

    final file = res.files.single;

    String text;

    // Web path is null; use bytes
    if (kIsWeb) {
      final Uint8List? bytes = file.bytes;
      if (bytes == null) return [];
      text = utf8.decode(bytes);
    } else {
      final path = file.path;
      if (path == null) return [];
      text = await File(path).readAsString();
    }

    final rows = const CsvToListConverter(
      shouldParseNumbers: false,
      eol: '\n',
    ).convert(text);

    if (rows.isEmpty) return [];

    // header row
    final header =
        rows.first.map((e) => e.toString().trim().toLowerCase()).toList();

    int idxOf(List<String> names) {
      for (final n in names) {
        final i = header.indexOf(n);
        if (i >= 0) return i;
      }
      return -1;
    }

    final nameIdx = idxOf(['name', 'full name', 'fullname']);
    final phoneIdx = idxOf(
        ['phone', 'mobile', 'cell', 'phone number', 'phonenumber']);
    final emailIdx = idxOf(['email', 'email address', 'emailaddress']);

    final out = <Contact>[];

    for (var r = 1; r < rows.length; r++) {
      final row = rows[r];
      if (row.isEmpty) continue;

      String pick(int i) =>
          (i >= 0 && i < row.length) ? row[i].toString().trim() : '';

      final name = pick(nameIdx);
      final phone = pick(phoneIdx);
      final email = pick(emailIdx);

      if (phone.isEmpty && email.isEmpty) continue;

      out.add(
        Contact(
          id: 'csv_${r}_${DateTime.now().millisecondsSinceEpoch}',
          name: name.isEmpty ? 'Unknown' : name,
          phone: phone.isEmpty ? null : phone,
          email: email.isEmpty ? null : email,
        ),
      );
    }

    return out;
  }
}