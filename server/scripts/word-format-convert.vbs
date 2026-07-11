' Convert between legacy .doc and modern .docx using Word COM.
' Args (each may arrive with surrounding quotes if the host quoted a
' path containing spaces, hence the StripQuotes helper):
'   0: input file path
'   1: output file path
'   2: target format code
'        16 = wdFormatXMLDocument (.docx)
'         0 = wdFormatDocument97 (.doc, Word 97-2003 binary)
Function StripQuotes(value)
  If Left(value, 1) = """" And Right(value, 1) = """" Then
    StripQuotes = Mid(value, 2, Len(value) - 2)
  Else
    StripQuotes = value
  End If
End Function

inputFile = StripQuotes(WScript.Arguments(0))
outputFile = StripQuotes(WScript.Arguments(1))
formatCode = CLng(StripQuotes(WScript.Arguments(2)))

On Error Resume Next

Set objWord = CreateObject("Word.Application")
If Err.Number <> 0 Then
  WScript.Echo "ERROR_CREATE_WORD: " & Err.Description
  WScript.Quit 2
End If
objWord.Visible = False
objWord.DisplayAlerts = 0  ' wdAlertsNone — suppress any "keep current format" prompts

Set objDoc = objWord.Documents.Open(inputFile)
If Err.Number <> 0 Then
  objWord.Quit
  WScript.Echo "ERROR_OPEN: " & Err.Description & " [" & inputFile & "]"
  WScript.Quit 3
End If

objDoc.SaveAs2 outputFile, formatCode
If Err.Number <> 0 Then
  objDoc.Close False
  objWord.Quit
  WScript.Echo "ERROR_SAVE: " & Err.Description & " [" & outputFile & "]"
  WScript.Quit 4
End If

objDoc.Close False
objWord.Quit
WScript.Echo "OK"